const prisma = require('../config/prismaClient');

// GET /api/wallet - Wallet summary for claim flow
exports.getWalletSummary = async (req, res) => {
    try {
        const userId = req.user.id;

        let wallet = await prisma.wallet.findUnique({
            where: { userId },
            include: {
                Transactions: {
                    orderBy: { createdAt: 'desc' },
                    take: 10
                }
            }
        });

        if (!wallet) {
            wallet = await prisma.wallet.create({
                data: { userId, balance: 0.00, currency: 'INR' },
                include: { Transactions: true }
            });
        }

        const recentTransactions = wallet.Transactions.map((tx) => ({
            id: tx.id,
            type: tx.type,
            amount: parseFloat(tx.amount),
            category: tx.category,
            status: tx.status,
            description: tx.description,
            referenceId: tx.referenceId,
            createdAt: tx.createdAt
        }));

        res.json({
            success: true,
            wallet: {
                balance: parseFloat(wallet.balance),
                currency: wallet.currency
            },
            recentTransactions
        });
    } catch (error) {
        console.error('Get wallet summary error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch wallet summary',
            error: error.message
        });
    }
};

// Get Wallet Overview (Screen 8)
exports.getWalletOverview = async (req, res) => {
    try {
        const userId = req.user.id;

        // Get or create wallet
        let wallet = await prisma.wallet.findUnique({
            where: { userId },
            include: {
                Transactions: {
                    where: { status: 'success' },
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        if (!wallet) {
            wallet = await prisma.wallet.create({
                data: { userId, balance: 0.00 },
                include: { Transactions: true }
            });
        }

        // Calculate balances
        const availableBalance = parseFloat(wallet.balance) - parseFloat(wallet.lockedBalance);
        const pendingBalance = parseFloat(wallet.lockedBalance);

        // Calculate lifetime earnings (sum of all successful credit transactions)
        const lifetimeEarnings = await prisma.transaction.aggregate({
            where: {
                walletId: wallet.id,
                type: 'credit',
                category: 'cashback_payout',
                status: 'success'
            },
            _sum: { amount: true }
        });

        // Get recent transactions (last 5)
        const recentTransactions = wallet.Transactions.slice(0, 5).map(tx => ({
            id: tx.id,
            type: tx.type,
            amount: parseFloat(tx.amount),
            category: tx.category,
            status: tx.status,
            description: tx.description,
            referenceId: tx.referenceId,
            createdAt: tx.createdAt
        }));

        res.json({
            success: true,
            wallet: {
                availableBalance,
                pendingBalance,
                lifetimeEarnings: parseFloat(lifetimeEarnings._sum.amount || 0),
                currency: wallet.currency,
                recentTransactions
            }
        });

    } catch (error) {
        console.error('Get wallet overview error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch wallet overview',
            error: error.message
        });
    }
};

// Get Transaction History (Screen 9)
exports.getTransactionHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const { page = 1, limit = 20, type, status, startDate, endDate } = req.query;

        const wallet = await prisma.wallet.findUnique({ where: { userId } });
        if (!wallet) {
            return res.status(404).json({ success: false, message: 'Wallet not found' });
        }

        // Build filter
        const where = { walletId: wallet.id };
        if (type) where.type = type;
        if (status) where.status = status;
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(startDate);
            if (endDate) where.createdAt.lte = new Date(endDate);
        }

        // Get total count
        const total = await prisma.transaction.count({ where });

        // Get paginated transactions
        const transactions = await prisma.transaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit)
        });

        res.json({
            success: true,
            transactions: transactions.map(tx => ({
                id: tx.id,
                type: tx.type,
                amount: parseFloat(tx.amount),
                category: tx.category,
                status: tx.status,
                description: tx.description,
                referenceId: tx.referenceId,
                createdAt: tx.createdAt
            })),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Get transaction history error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch transaction history',
            error: error.message
        });
    }
};

// Request Payout (Screen 10)
exports.requestPayout = async (req, res) => {
    try {
        const userId = req.user.id;
        const { amount, payoutMethodId, upiId } = req.body;

        // Configuration
        const MIN_PAYOUT_AMOUNT = 10;
        const DAILY_LIMIT = 5000;

        // Validate amount
        if (!amount || parseFloat(amount) < MIN_PAYOUT_AMOUNT) {
            return res.status(400).json({ success: false, message: `Minimum payout amount is ₹${MIN_PAYOUT_AMOUNT}` });
        }

        // Get wallet
        const wallet = await prisma.wallet.findUnique({ where: { userId }, include: { User: true } });
        if (!wallet) {
            return res.status(404).json({ success: false, message: 'Wallet not found' });
        }

        const availableBalance = parseFloat(wallet.balance) - parseFloat(wallet.lockedBalance);

        // Check balance
        if (parseFloat(amount) > availableBalance) {
            return res.status(400).json({ success: false, message: 'Insufficient balance' });
        }

        // Check daily limit
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayWithdrawals = await prisma.withdrawal.aggregate({
            where: {
                walletId: wallet.id,
                createdAt: { gte: today },
                status: { in: ['pending', 'processing', 'on_hold', 'completed'] }
            },
            _sum: { amount: true }
        });

        const totalToday = parseFloat(todayWithdrawals._sum.amount || 0);
        if (totalToday + parseFloat(amount) > DAILY_LIMIT) {
            return res.status(400).json({
                success: false,
                message: `Daily limit of ₹${DAILY_LIMIT} exceeded. You've withdrawn ₹${totalToday} today.`
            });
        }

        // Verify or Create payout method
        let finalPayoutMethodId = payoutMethodId;
        
        if (!finalPayoutMethodId && upiId) {
            const { encrypt, decrypt } = require('../utils/encryption');
            const normalizedUpi = String(upiId).trim().toLowerCase();
            
            // Check if user already has this UPI saved
            const existingMethods = await prisma.payoutMethod.findMany({
                where: { userId, type: 'upi' }
            });
            
            const match = existingMethods.find(m => {
                try { return decrypt(m.value) === normalizedUpi; } catch(e) { return m.value === normalizedUpi; }
            });
            
            if (match) {
                finalPayoutMethodId = match.id;
            } else {
                // Create it
                const newMethod = await prisma.payoutMethod.create({
                    data: {
                        userId,
                        type: 'upi',
                        value: encrypt(normalizedUpi),
                        details: { upiId: normalizedUpi },
                        isPrimary: existingMethods.length === 0
                    }
                });
                finalPayoutMethodId = newMethod.id;
            }
        }

        if (!finalPayoutMethodId) {
            return res.status(400).json({ success: false, message: 'Please provide upiId or payoutMethodId' });
        }

        const payoutMethod = await prisma.payoutMethod.findUnique({
            where: { id: finalPayoutMethodId }
        });

        if (!payoutMethod || payoutMethod.userId !== userId || payoutMethod.type !== 'upi') {
            return res.status(400).json({ success: false, message: 'Invalid or unsupported payout method (UPI required)' });
        }

        // 1. Create withdrawal request and lock balance FIRST
        const withdrawal = await prisma.$transaction(async (tx) => {
            await tx.wallet.update({
                where: { id: wallet.id },
                data: { lockedBalance: { increment: parseFloat(amount) } }
            });

            return await tx.withdrawal.create({
                data: {
                    walletId: wallet.id,
                    amount: parseFloat(amount),
                    status: 'pending',
                    payoutMethodId: finalPayoutMethodId
                },
                include: { PayoutMethod: true }
            });
        });

        console.log(`[PAYOUT] Withdrawal ${withdrawal.id} created (pending). Initiating RBL payout.`);

        // 2. Hand off to the RBL payout service. Final success/failure is
        //    determined by the status-enquiry worker; wallet movements are
        //    applied there. NEVER refund here on an exception/timeout - the
        //    bank may still pay out.
        const rblPayoutService = require('../services/rblPayoutService');
        let result;
        try {
            result = await rblPayoutService.initiatePayout(withdrawal.id);
        } catch (initError) {
            console.error(`[PAYOUT] initiatePayout error for withdrawal ${withdrawal.id} (left for reconciliation):`, initError.message);
            result = await prisma.withdrawal.findUnique({ where: { id: withdrawal.id } }).catch(() => null);
        }

        const finalStatus = (result && result.status) || 'pending';
        let message;
        switch (finalStatus) {
            case 'completed':
                message = 'Payout processed to your bank account!';
                break;
            case 'on_hold':
                message = 'Payout is under review and will be updated soon.';
                break;
            case 'failed':
                message = `Payout failed: ${(result && result.rejectionReason) || 'please try again'}`;
                break;
            case 'processing':
                message = 'Payout initiated. It will be credited to your UPI shortly.';
                break;
            default:
                message = 'Payout request received and is being processed.';
        }

        res.status(finalStatus === 'failed' ? 400 : 200).json({
            success: finalStatus !== 'failed',
            message,
            withdrawal: {
                id: withdrawal.id,
                amount: parseFloat(amount),
                status: finalStatus,
                payoutMethod: withdrawal.PayoutMethod.value,
                createdAt: withdrawal.createdAt
            }
        });

    } catch (error) {
        console.error('Request payout error:', error);
        res.status(500).json({ success: false, message: 'Failed to request payout', error: error.message });
    }
};
exports.getPayoutStatus = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        const withdrawal = await prisma.withdrawal.findUnique({
            where: { id },
            include: {
                PayoutMethod: true,
                Wallet: {
                    include: { User: true }
                }
            }
        });

        if (!withdrawal) {
            return res.status(404).json({ success: false, message: 'Payout not found' });
        }

        // Verify ownership
        if (withdrawal.Wallet.userId !== userId) {
            return res.status(403).json({ success: false, message: 'Unauthorized' });
        }

        res.json({
            success: true,
            payout: {
                id: withdrawal.id,
                amount: parseFloat(withdrawal.amount),
                status: withdrawal.status,
                payoutMethod: withdrawal.PayoutMethod.value,
                referenceId: withdrawal.referenceId,
                adminNote: withdrawal.adminNote,
                rejectionReason: withdrawal.rejectionReason,
                createdAt: withdrawal.createdAt,
                updatedAt: withdrawal.updatedAt
            }
        });

    } catch (error) {
        console.error('Get payout status error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payout status',
            error: error.message
        });
    }
};

// Get user's payout methods
exports.getPayoutMethods = async (req, res) => {
    try {
        const userId = req.user.id;

        const methods = await prisma.payoutMethod.findMany({
            where: { userId },
            orderBy: [{ isPrimary: 'desc' }, { createdAt: 'desc' }]
        });

        res.json({
            success: true,
            payoutMethods: methods.map(method => ({
                id: method.id,
                type: method.type,
                value: method.value,
                isPrimary: method.isPrimary,
                createdAt: method.createdAt
            }))
        });

    } catch (error) {
        console.error('Get payout methods error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch payout methods',
            error: error.message
        });
    }
};

module.exports = exports;
