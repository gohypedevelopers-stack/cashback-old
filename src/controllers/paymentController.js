const prisma = require('../config/prismaClient');
const crypto = require('crypto');
const razorpay = require('../config/razorpay');
const { safeLogActivity } = require('../utils/activityLogger');
const { encrypt, decrypt } = require('../utils/encryption');

const normalizeText = (value) => (typeof value === 'string' ? value.trim() : '');
const isValidUpiId = (value) => /^[a-zA-Z0-9._-]{2,}@[a-zA-Z]{2,}$/.test(value || '');
const isValidAccountNumber = (value) => /^[0-9]{9,18}$/.test(value || '');
const isValidIfsc = (value) => /^[A-Z]{4}0[A-Z0-9]{6}$/.test(value || '');
const MAX_RAZORPAY_ORDER_AMOUNT_INR = Number(
    process.env.RAZORPAY_MAX_ORDER_AMOUNT_INR || 500000
);

const buildBankPayoutLabel = ({ bankName, accountHolderName, accountNumber, ifsc }) => {
    const suffix = accountNumber.slice(-4);
    const parts = [
        normalizeText(bankName) || 'Bank',
        normalizeText(accountHolderName) || 'Account',
        `XXXX${suffix}`,
        ifsc
    ];
    return parts.join(' | ');
};

// --- Payout Methods (UPI / BANK) ---

exports.addPayoutMethod = async (req, res) => {
    try {
        const { type, value, details, upiId, bank } = req.body;
        const userId = req.user.id; // User or Vendor (via User ID)
        const normalizedType = String(type || '').trim().toLowerCase();
        let payload;

        if (normalizedType === 'upi') {
            const normalizedUpi = normalizeText(upiId || value || details?.upiId).toLowerCase();
            if (!isValidUpiId(normalizedUpi)) {
                return res.status(400).json({ message: 'Invalid UPI ID' });
            }
            payload = {
                type: 'upi',
                value: normalizedUpi,
                details: { upiId: normalizedUpi }
            };
        } else if (normalizedType === 'bank') {
            const bankInput = bank || details || {};
            const accountNumber = normalizeText(bankInput.accountNumber);
            const ifsc = normalizeText(bankInput.ifsc).toUpperCase();
            const accountHolderName = normalizeText(bankInput.accountHolderName);
            const bankName = normalizeText(bankInput.bankName);

            if (!isValidAccountNumber(accountNumber)) {
                return res.status(400).json({ message: 'Invalid bank account number' });
            }
            if (!isValidIfsc(ifsc)) {
                return res.status(400).json({ message: 'Invalid IFSC code' });
            }

            payload = {
                type: 'bank',
                value: buildBankPayoutLabel({ bankName, accountHolderName, accountNumber, ifsc }),
                details: { accountNumber, ifsc, accountHolderName, bankName }
            };
        } else {
            return res.status(400).json({ message: 'Payout method type must be "upi" or "bank"' });
        }

        // Check if primary exists
        const existingPrimary = await prisma.payoutMethod.findFirst({
            where: { userId, isPrimary: true }
        });

        const method = await prisma.payoutMethod.create({
            data: {
                userId,
                type: payload.type,
                value: encrypt(payload.value),
                details: payload.details ? JSON.parse(JSON.stringify(payload.details)) : null, // Prisma handles Json?
                isPrimary: !existingPrimary // Auto-set primary if first one
            }
        });
        
        // SECURITY: Encrypt JSON details if present
        if (method.details) {
            await prisma.payoutMethod.update({
                where: { id: method.id },
                data: { details: encrypt(JSON.stringify(payload.details)) }
            });
        }

        res.status(201).json({ message: 'Payout method added', method });
    } catch (error) {
        res.status(500).json({ message: 'Error adding payout method', error: error.message });
    }
};

exports.getPayoutMethods = async (req, res) => {
    try {
        const methods = await prisma.payoutMethod.findMany({
            where: { userId: req.user.id }
        });
        
        const decryptedMethods = methods.map(m => {
            try {
                return {
                    ...m,
                    value: decrypt(m.value),
                    details: m.details && typeof m.details === 'string' ? JSON.parse(decrypt(m.details)) : m.details
                };
            } catch (e) {
                return m; // Fallback for old unencrypted data
            }
        });

        res.json(decryptedMethods);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching methods', error: error.message });
    }
};

exports.deletePayoutMethod = async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.user.id;

        const method = await prisma.payoutMethod.findUnique({ where: { id } });

        if (!method) {
            return res.status(404).json({ message: 'Method not found' });
        }

        if (method.userId !== userId) {
            return res.status(401).json({ message: 'Not authorized to delete this method' });
        }

        await prisma.payoutMethod.delete({ where: { id } });
        res.json({ message: 'Payout method deleted' });

    } catch (error) {
        res.status(500).json({ message: 'Error deleting method', error: error.message });
    }
};

// --- Withdrawals ---

exports.requestWithdrawal = async (req, res) => {
    try {
        const { amount, payoutMethodId } = req.body;
        const userId = req.user.id;

        // 1. Get Wallet with ROW LOCK to prevent race conditions
        const wallet = await prisma.$transaction(async (tx) => {
            // Find wallet ID first
            let w = await tx.wallet.findUnique({ where: { userId } });
            if (!w) {
                const vendor = await tx.vendor.findUnique({ where: { userId } });
                if (vendor) {
                    w = await tx.wallet.findUnique({ where: { vendorId: vendor.id } });
                }
            }
            if (!w) return null;

            // Lock the row
            await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "id" = ${w.id} FOR UPDATE`;
            
            // Return fresh data
            return await tx.wallet.findUnique({ where: { id: w.id } });
        });

        if (!wallet) {
            return res.status(404).json({ message: 'Wallet not found' });
        }

        // 2. Validate Amount
        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ message: 'Invalid amount' });
        }
        if (parseFloat(wallet.balance) < numericAmount) {
            return res.status(400).json({ message: 'Insufficient balance' });
        }

        // 3. Handle Payout Method (saved method OR direct UPI OR direct bank details)
        let methodId = null;
        let methodObj = null;
        const { upiId } = req.body;
        const bankInput = req.body.bank && typeof req.body.bank === 'object' ? req.body.bank : null;

        if (payoutMethodId) {
            // Traditional flow: Select saved method
            const method = await prisma.payoutMethod.findUnique({ where: { id: payoutMethodId } });
            if (!method || method.userId !== userId) {
                return res.status(400).json({ message: 'Invalid payout method' });
            }
            methodId = method.id;
            methodObj = method;
        } else if (normalizeText(upiId)) {
            const normalizedUpi = normalizeText(upiId).toLowerCase();
            if (!isValidUpiId(normalizedUpi)) {
                return res.status(400).json({ message: 'Invalid UPI ID' });
            }

            let method = await prisma.payoutMethod.findFirst({
                where: { userId, type: 'upi', value: normalizedUpi }
            });

            if (!method) {
                await prisma.payoutMethod.updateMany({
                    where: { userId, isPrimary: true },
                    data: { isPrimary: false }
                });

                method = await prisma.payoutMethod.create({
                    data: {
                        userId,
                        type: 'upi',
                        value: normalizedUpi,
                        details: { upiId: normalizedUpi },
                        isPrimary: true
                    }
                });
            }

            methodId = method.id;
            methodObj = method;
        } else if (bankInput) {
            const accountNumber = normalizeText(bankInput.accountNumber);
            const ifsc = normalizeText(bankInput.ifsc).toUpperCase();
            const accountHolderName = normalizeText(bankInput.accountHolderName);
            const bankName = normalizeText(bankInput.bankName);

            if (!isValidAccountNumber(accountNumber)) {
                return res.status(400).json({ message: 'Invalid bank account number' });
            }
            if (!isValidIfsc(ifsc)) {
                return res.status(400).json({ message: 'Invalid IFSC code' });
            }

            const existingBankMethods = await prisma.payoutMethod.findMany({
                where: { userId, type: 'bank' }
            });

            let method = existingBankMethods.find((item) => {
                const details = item.details || {};
                return details.accountNumber === accountNumber && String(details.ifsc || '').toUpperCase() === ifsc;
            });

            if (!method) {
                await prisma.payoutMethod.updateMany({
                    where: { userId, isPrimary: true },
                    data: { isPrimary: false }
                });

                method = await prisma.payoutMethod.create({
                    data: {
                        userId,
                        type: 'bank',
                        value: buildBankPayoutLabel({ bankName, accountHolderName, accountNumber, ifsc }),
                        details: { accountNumber, ifsc, accountHolderName, bankName },
                        isPrimary: true
                    }
                });
            }

            methodId = method.id;
            methodObj = method;
        } else {
            return res.status(400).json({ message: 'Please provide upiId, bank details, or payoutMethodId' });
        }

        if (!methodObj) {
            methodObj = await prisma.payoutMethod.findUnique({ where: { id: methodId } });
        }

        // 4. Create Withdrawal Request Transactionally
        const withdrawal = await prisma.$transaction(async (tx) => {
            // Lock the row to prevent race conditions (Overspending)
            await tx.$queryRaw`SELECT "id" FROM "Wallet" WHERE "id" = ${wallet.id} FOR UPDATE`;
            
            // Re-fetch fresh balance after lock
            const lockedWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });
            if (Number(lockedWallet.balance) < numericAmount) {
                throw new Error('Insufficient balance');
            }

            // Deduct from Balance and move to LockedBalance
            await tx.wallet.update({
                where: { id: wallet.id },
                data: {
                    balance: { decrement: numericAmount },
                    lockedBalance: { increment: numericAmount }
                }
            });

            // Create Transaction Log
            await tx.transaction.create({
                data: {
                    walletId: wallet.id,
                    type: 'debit',
                    amount: numericAmount,
                    category: 'withdrawal',
                    status: 'pending', // Pending Admin Approval
                    description: methodObj?.type === 'bank'
                        ? `Withdrawal request to bank (${methodObj.value})`
                        : `Withdrawal request to ${methodObj.value}`
                }
            });

            // Create Withdrawal Record
            return await tx.withdrawal.create({
                data: {
                    walletId: wallet.id,
                    amount: numericAmount,
                    status: 'pending',
                    payoutMethodId: methodId
                }
            });
        });

        console.log('[PAYOUT] initiated', {
            userId,
            amount: numericAmount,
            payoutMethodId: methodId,
            withdrawalId: withdrawal.id
        });
        safeLogActivity({
            actorUserId: userId,
            actorRole: req.user?.role,
            action: 'payout_initiated',
            entityType: 'withdrawal',
            entityId: withdrawal.id,
            metadata: { amount: numericAmount, payoutMethodId: methodId },
            req
        });

        res.status(201).json({ message: 'Withdrawal requested successfully', withdrawal });

    } catch (error) {
        res.status(500).json({ message: 'Withdrawal request failed', error: error.message });
    }
};

exports.getWithdrawalHistory = async (req, res) => {
    try {
        const userId = req.user.id;

        // Find Wallet (same logic as above)
        let wallet = await prisma.wallet.findUnique({ where: { userId } });
        let vendor = null;
        if (!wallet) {
            vendor = await prisma.vendor.findUnique({ where: { userId } });
            if (vendor) {
                wallet = await prisma.wallet.findUnique({ where: { vendorId: vendor.id } });
            }
        }

        if (!wallet) return res.json([]); // No wallet, no history

        const history = await prisma.withdrawal.findMany({
            where: { walletId: wallet.id },
            include: { PayoutMethod: true },
            orderBy: { createdAt: 'desc' }
        });

        res.json(history);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching history', error: error.message });
    }
};

// Expose the Razorpay public key from the backend so the frontend does not rely on env fallback.
exports.getRazorpayConfig = async (req, res) => {
    try {
        const keyId = String(process.env.RAZORPAY_KEY_ID || '').trim();
        if (!keyId) {
            return res.status(503).json({ message: 'Razorpay is not configured.' });
        }

        res.json({ keyId });
    } catch (error) {
        res.status(500).json({ message: 'Unable to load payment configuration', error: error.message });
    }
};
// --- Razorpay Integration ---

exports.createOrder = async (req, res) => {
    try {
        const { amount, currency = "INR", receipt, notes } = req.body;
        if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
            return res.status(503).json({
                message: "Payment gateway is not configured. Please contact support."
            });
        }

        const numericAmount = Number(amount);
        if (!Number.isFinite(numericAmount) || numericAmount <= 0) {
            return res.status(400).json({ message: "Invalid amount" });
        }
        if (
            Number.isFinite(MAX_RAZORPAY_ORDER_AMOUNT_INR) &&
            numericAmount > MAX_RAZORPAY_ORDER_AMOUNT_INR
        ) {
            return res.status(400).json({
                message: `Maximum single payment is INR ${MAX_RAZORPAY_ORDER_AMOUNT_INR.toLocaleString('en-IN')}. Please split into multiple payments.`
            });
        }

        const options = {
            amount: Math.round(numericAmount * 100), // Convert to paise
            currency,
            receipt: receipt || `receipt_${Date.now()}`,
            notes: notes || {}
        };

        const order = await razorpay.orders.create(options);
        res.json(order);
    } catch (error) {
        console.error("[Razorpay Error]", error);
        const statusCode = error.statusCode || (error?.error ? 400 : 500);
        const message = error.error && error.error.description
            ? error.error.description
            : (error.message || "Something went wrong");
        res.status(statusCode).json({ message, error: message });
    }
};

exports.verifyPayment = async (req, res) => {
    try {
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        const userId = req.user.id;

        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ message: "Missing payment verification details", success: false });
        }

        // Prevent duplicate credits on retry/reload.
        const existingRecharge = await prisma.transaction.findFirst({
            where: {
                referenceId: razorpay_payment_id,
                category: 'recharge',
                status: 'success'
            }
        });
        if (existingRecharge) {
            return res.json({ message: "Payment already verified", success: true });
        }

        const body = razorpay_order_id + "|" + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body.toString())
            .digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ message: "Invalid signature", success: false });
        }

        // Fetch order to get exact amount (Secure)
        const order = await razorpay.orders.fetch(razorpay_order_id);
        const amountInRupees = order.amount / 100;

        // Find wallet, preferring vendor wallet for vendor users.
        let vendor = null;
        if (req.user?.role === 'vendor') {
            vendor = await prisma.vendor.findUnique({ where: { userId } });
        }

        let wallet = null;
        if (vendor) {
            wallet = await prisma.wallet.findUnique({ where: { vendorId: vendor.id } });
        }
        if (!wallet) {
            wallet = await prisma.wallet.findUnique({ where: { userId } });
        }
        if (!wallet && !vendor) {
            vendor = await prisma.vendor.findUnique({ where: { userId } });
            if (vendor) {
                wallet = await prisma.wallet.findUnique({ where: { vendorId: vendor.id } });
            }
        }

        if (!wallet) {
            // Auto-create wallet if not exists
            wallet = await prisma.wallet.create({
                data: vendor
                    ? { vendorId: vendor.id, balance: 0, currency: 'INR' }
                    : { userId, balance: 0, currency: 'INR' }
            });
        }

        // Atomic Transaction
        await prisma.$transaction(async (tx) => {
            await tx.wallet.update({
                where: { id: wallet.id },
                data: { balance: { increment: amountInRupees } }
            });

            await tx.transaction.create({
                data: {
                    walletId: wallet.id,
                    type: 'credit',
                    amount: amountInRupees,
                    category: 'recharge', // Ensure 'recharge' is in enum
                    status: 'success',
                    referenceId: razorpay_payment_id,
                    description: "Razorpay Recharge"
                }
            });
        });

        await prisma.notification.create({
            data: {
                userId,
                title: "Wallet recharged",
                message: `Wallet credited by INR ${amountInRupees}.`,
                type: "wallet-recharge",
                metadata: { tab: "wallet", amount: amountInRupees, isVendor: Boolean(vendor) }
            }
        });

        res.json({ message: "Payment verified successfully", success: true });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: "Internal Server Error", error: error.message });
    }
};

