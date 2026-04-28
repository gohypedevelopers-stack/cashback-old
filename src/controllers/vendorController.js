const prisma = require('../config/prismaClient');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { parsePagination } = require('../utils/pagination');
const { safeLogVendorActivity } = require('../utils/vendorActivityLogger');
const {
    ensureVendorWallet,
    creditAvailable,
    lock,
    chargeFee,
    getWalletSnapshot,
    unlockRefund
} = require('../services/walletService');
const {
    getVendorBulkExportArtifact,
    getVendorBulkExportJob,
    listVendorBulkExportJobs,
    queueCampaignExportJob,
    queueInventoryExportJob
} = require('../services/bulkQrExportService');
const {
    allocateInventoryQrs,
    importInventorySeries,
    normalizeSeriesCode,
    seedVendorInventory
} = require('../services/qrInventoryService');
const {
    resolvePostpaidSheetSize,
    resolvePostpaidSheetCount
} = require('../utils/postpaidSheet');
const { createInvoice, renderInvoiceToBuffer, withShareToken } = require('../services/invoiceService');
const { logInvoiceCreation } = require('../utils/debugLogger');

const DEFAULT_VENDOR_QR_INVENTORY = Number(process.env.DEFAULT_VENDOR_QR_INVENTORY || 0);
const AUTO_SEED_VENDOR_QR_INVENTORY =
    String(process.env.AUTO_SEED_VENDOR_QR_INVENTORY || 'false').toLowerCase() === 'true';
const DEFAULT_VENDOR_QR_SERIES_CODES = String(
    process.env.DEFAULT_VENDOR_QR_SERIES_CODES || 'A,B,C,D,E,F,G,H,I,J'
)
    .split(',')
    .map((code) => code.trim())
    .filter(Boolean);
const DEFAULT_VENDOR_QR_SERIES_SIZE = Number(process.env.DEFAULT_VENDOR_QR_SERIES_SIZE || 100);
const INVOICE_GST_RATE = Number(process.env.INVOICE_GST_RATE || 0.18);
const LARGE_TX_TIMEOUT_MS = Number.isFinite(Number(process.env.VENDOR_LARGE_TX_TIMEOUT_MS))
    ? Number(process.env.VENDOR_LARGE_TX_TIMEOUT_MS)
    : 900000;
const LARGE_TX_MAX_WAIT_MS = Number.isFinite(Number(process.env.VENDOR_TX_MAX_WAIT_MS))
    ? Number(process.env.VENDOR_TX_MAX_WAIT_MS)
    : 10000;
const CAMPAIGN_QR_DOWNLOAD_CHUNK_MAX = Number.isFinite(Number(process.env.CAMPAIGN_QR_DOWNLOAD_CHUNK_MAX))
    ? Math.max(200, Number(process.env.CAMPAIGN_QR_DOWNLOAD_CHUNK_MAX))
    : 5000;
const CAMPAIGN_QR_FULL_DOWNLOAD_LIMIT = Number.isFinite(Number(process.env.CAMPAIGN_QR_FULL_DOWNLOAD_LIMIT))
    ? Math.max(1000, Number(process.env.CAMPAIGN_QR_FULL_DOWNLOAD_LIMIT))
    : 10000;
const LEGACY_BILLABLE_CATEGORIES = [
    'campaign_payment',
    'qr_purchase',
    'tech_fee_charge',
    'voucher_fee_charge',
    'lock_funds',
    'unlock_refund',
    'refund',
    'recharge'
];

const isEnumInputError = (error) => {
    const message = String(error?.message || '').toLowerCase();
    return (
        message.includes('invalid input value for enum') ||
        message.includes('enum') && message.includes('invalid input')
    );
};

const getSupportedLegacyBillableCategories = async (tx) => {
    try {
        const rows = await tx.$queryRaw`
            SELECT e.enumlabel
            FROM pg_enum e
            JOIN pg_type t ON t.oid = e.enumtypid
            WHERE t.typname = 'TransactionCategory'
        `;
        const available = new Set((rows || []).map((row) => String(row.enumlabel || '').trim()));
        const supported = LEGACY_BILLABLE_CATEGORIES.filter((value) => available.has(value));
        return supported;
    } catch (error) {
        // If enum introspection fails, use the static list and let the guarded query handle retries.
        return [...LEGACY_BILLABLE_CATEGORIES];
    }
};

// Helper to generate unique hash
const generateQRHash = () => {
    return crypto.randomBytes(32).toString('hex');
};

const resolveTechFeePerQr = ({ vendor, brand }) => {
    const vendorTechFee = Number(vendor?.techFeePerQr);
    if (Number.isFinite(vendorTechFee) && vendorTechFee > 0) return vendorTechFee;

    const legacyQrPrice = Number(brand?.qrPricePerUnit);
    if (Number.isFinite(legacyQrPrice) && legacyQrPrice > 0) return legacyQrPrice;

    return 1;
};

const LEGACY_LOCKABLE_QR_STATUSES = ['generated', 'active', 'assigned', 'funded', 'redeemed'];
const LEGACY_OUTSTANDING_QR_STATUSES = new Set(['generated', 'active', 'assigned', 'funded']);
const POSTPAID_MUTABLE_QR_STATUSES = ['funded', 'generated', 'active', 'assigned'];
const POSTPAID_SHEET_QR_STATUSES = [...POSTPAID_MUTABLE_QR_STATUSES, 'redeemed'];
const POSTPAID_MUTABLE_QR_STATUS_SET = new Set(POSTPAID_MUTABLE_QR_STATUSES);
const POSTPAID_REDEEMED_QR_STATUS = 'redeemed';

const toRomanSheetLabel = (value) => {
    return String(Math.max(1, Math.floor(value)));
};

const backfillLegacyLockedBudgets = async (tx, vendorId) => {
    const orphanCount = await tx.qRCode.count({
        where: {
            vendorId,
            campaignId: { not: null },
            campaignBudgetId: null,
            status: { in: LEGACY_LOCKABLE_QR_STATUSES }
        }
    });

    if (!orphanCount) {
        return {
            migrated: false,
            lockedAdded: 0,
            linkedQrs: 0
        };
    }

    const grouped = await tx.qRCode.groupBy({
        by: ['campaignId', 'status'],
        where: {
            vendorId,
            campaignId: { not: null },
            campaignBudgetId: null,
            status: { in: LEGACY_LOCKABLE_QR_STATUSES }
        },
        _sum: { cashbackAmount: true },
        _count: { _all: true }
    });

    const campaignMap = new Map();
    grouped.forEach((row) => {
        const campaignId = row.campaignId;
        if (!campaignId) return;

        const current = campaignMap.get(campaignId) || {
            totalAmount: 0,
            remainingAmount: 0,
            spentAmount: 0,
            count: 0
        };

        const amount = Number(row?._sum?.cashbackAmount || 0);
        current.totalAmount += amount;
        current.count += Number(row?._count?._all || 0);

        if (LEGACY_OUTSTANDING_QR_STATUSES.has(String(row.status))) {
            current.remainingAmount += amount;
        } else {
            current.spentAmount += amount;
        }

        campaignMap.set(campaignId, current);
    });

    let lockedAdded = 0;
    let linkedQrs = 0;
    const campaignRefs = [];

    for (const [campaignId, summary] of campaignMap.entries()) {
        if (summary.totalAmount <= 0) {
            continue;
        }

        let campaignBudget = await tx.campaignBudget.findFirst({
            where: {
                vendorId,
                campaignId,
                status: 'active'
            },
            orderBy: { createdAt: 'desc' }
        });

        if (campaignBudget) {
            campaignBudget = await tx.campaignBudget.update({
                where: { id: campaignBudget.id },
                data: {
                    initialLockedAmount: { increment: summary.totalAmount },
                    lockedAmount: { increment: summary.remainingAmount },
                    spentAmount: { increment: summary.spentAmount },
                    status: summary.remainingAmount > 0 ? 'active' : campaignBudget.status
                }
            });
        } else {
            campaignBudget = await tx.campaignBudget.create({
                data: {
                    campaignId,
                    vendorId,
                    initialLockedAmount: summary.totalAmount,
                    lockedAmount: summary.remainingAmount,
                    spentAmount: summary.spentAmount,
                    refundedAmount: 0,
                    status: summary.remainingAmount > 0 ? 'active' : 'closed'
                }
            });
        }

        const linked = await tx.qRCode.updateMany({
            where: {
                vendorId,
                campaignId,
                campaignBudgetId: null,
                status: { in: LEGACY_LOCKABLE_QR_STATUSES }
            },
            data: {
                campaignBudgetId: campaignBudget.id
            }
        });

        linkedQrs += Number(linked?.count || 0);
        lockedAdded += summary.remainingAmount;
        campaignRefs.push({
            campaignId,
            campaignBudgetId: campaignBudget.id,
            remainingAmount: Number(summary.remainingAmount.toFixed(2))
        });
    }

    if (lockedAdded > 0) {
        const wallet = await ensureVendorWallet(tx, vendorId);
        await tx.wallet.update({
            where: { id: wallet.id },
            data: {
                balance: { increment: lockedAdded },
                lockedBalance: { increment: lockedAdded }
            }
        });

        await tx.transaction.create({
            data: {
                walletId: wallet.id,
                type: 'debit',
                amount: Number(lockedAdded.toFixed(2)),
                category: 'lock_funds',
                status: 'success',
                description: 'Legacy QR commitments migrated to locked balance',
                referenceId: `legacy-lock-${vendorId}`,
                metadata: {
                    source: 'legacy_lock_backfill',
                    campaignRefs
                }
            }
        });
    }

    return {
        migrated: true,
        lockedAdded: Number(lockedAdded.toFixed(2)),
        linkedQrs
    };
};

// Helper: Ensure Vendor and Wallet exist
const ensureVendorAndWallet = async (userId, tx = prisma) => {
    let vendor = await tx.vendor.findUnique({ where: { userId } });
    if (!vendor) {
        // Create Vendor Profile
        const user = await tx.user.findUnique({ where: { id: userId } });
        if (!user) throw new Error('User not found');

        const businessName = user.name || user.username || 'My Company';

        vendor = await tx.vendor.create({
            data: {
                userId,
                businessName,
                contactEmail: user.email || null,
                status: 'active'
            }
        });
    }

    const wallet = await ensureVendorWallet(tx, vendor.id);

    if (vendor.status === 'active') {
        await backfillLegacyLockedBudgets(tx, vendor.id);
        if (AUTO_SEED_VENDOR_QR_INVENTORY && DEFAULT_VENDOR_QR_INVENTORY > 0) {
            await seedVendorInventory(tx, vendor.id, DEFAULT_VENDOR_QR_INVENTORY, {
                seriesCodes: DEFAULT_VENDOR_QR_SERIES_CODES,
                perSeriesCount: DEFAULT_VENDOR_QR_SERIES_SIZE,
                sourceBatch: 'AUTO_SERIES_SEED'
            });
        }
    }

    const refreshedWallet = await tx.wallet.findUnique({ where: { id: wallet.id } });

    return { vendor, wallet: refreshedWallet || wallet };
};

const requireVendorProfile = async (tx, userId) => {
    const vendor = await tx.vendor.findUnique({ where: { userId } });
    if (!vendor) {
        const error = new Error('Vendor profile not found');
        error.status = 404;
        throw error;
    }
    if (vendor.status !== 'active') {
        const error = new Error(`Vendor account is ${vendor.status}. Access denied.`);
        error.status = 403;
        throw error;
    }

    return vendor;
};

const toNumber = (value, fallback = 0) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return fallback;
    return Number(numeric.toFixed(2));
};

const toPositiveAmount = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Number(numeric.toFixed(2));
};

const normalizeVoucherType = (value, fallback = 'none') => {
    const candidate = typeof value === 'string' ? value.trim() : '';
    if (['digital_voucher', 'printed_qr', 'none'].includes(candidate)) {
        return candidate;
    }
    return fallback;
};

const normalizeAllocationRows = (allocations, { isPostpaid = false } = {}) => {
    if (!Array.isArray(allocations)) return [];

    return allocations
        .map((allocation) => {
            const quantity = Number.parseInt(allocation?.quantity, 10) || 0;
            const cashbackAmount = toPositiveAmount(allocation?.cashbackAmount) || 0;
            const providedTotalBudget = Number.parseFloat(allocation?.totalBudget);
            const totalBudget = isPostpaid
                ? 0
                : toNumber(
                    Number.isFinite(providedTotalBudget)
                        ? providedTotalBudget
                        : cashbackAmount * quantity,
                    0
                );

            return {
                quantity,
                cashbackAmount,
                totalBudget
            };
        })
        .filter((row) => row.quantity > 0 && (isPostpaid || row.cashbackAmount > 0));
};

const buildDateRange = (query = {}) => {
    const createdAt = {};
    const fromValue = query.dateFrom || query.from;
    const toValue = query.dateTo || query.to;
    if (fromValue) {
        const start = new Date(fromValue);
        if (!Number.isNaN(start.getTime())) {
            createdAt.gte = start;
        }
    }
    if (toValue) {
        const end = new Date(toValue);
        if (!Number.isNaN(end.getTime())) {
            end.setHours(23, 59, 59, 999);
            createdAt.lte = end;
        }
    }
    return Object.keys(createdAt).length ? createdAt : null;
};

const createFinanceInvoice = async (
    tx,
    {
        vendorId,
        brandId,
        campaignBudgetId,
        type,
        subtotal,
        tax = 0,
        label,
        metadata,
        items: explicitItems
    }
) => {
    logInvoiceCreation('createFinanceInvoice', { type, label, explicitItemsCount: explicitItems?.length });
    const safeSubtotal = toNumber(subtotal, 0);
    const safeTax = toNumber(tax, 0);
    const total = toNumber(safeSubtotal + safeTax, 0);

    let items = explicitItems;

    if (!items) {
        // Fallback: Build itemized breakdown from metadata when available
        const qty = Number(metadata?.quantity) || 1;
        const feePerQr = Number(metadata?.feePerQr) || 0;
        const cashbackPerQr = Number(metadata?.cashbackAmount) || 0;

        if (type === 'FEE_TAX_INVOICE' && feePerQr > 0 && qty > 1) {
            // Tech fee invoice: show qty × fee per QR
            items = [
                {
                    label: label || 'Technology Fee',
                    qty,
                    unitPrice: toNumber(feePerQr, 0),
                    amount: safeSubtotal,
                    taxRate: safeTax > 0 ? INVOICE_GST_RATE * 100 : null
                }
            ];
        } else if (type === 'DEPOSIT_RECEIPT' && cashbackPerQr > 0 && qty > 1) {
            // Deposit receipt: show qty × cashback per QR
            items = [
                {
                    label: label || 'Cashback Deposit',
                    qty,
                    unitPrice: toNumber(cashbackPerQr, 0),
                    amount: safeSubtotal,
                    taxRate: null
                }
            ];
        } else {
            // Default single-line item
            items = [
                {
                    label,
                    qty: 1,
                    unitPrice: safeSubtotal,
                    amount: safeSubtotal,
                    taxRate: safeSubtotal > 0 && safeTax > 0 ? INVOICE_GST_RATE * 100 : null
                }
            ];
        }
    }

    return createInvoice(tx, {
        vendorId,
        brandId: brandId || null,
        campaignBudgetId: campaignBudgetId || null,
        type,
        subtotal: safeSubtotal,
        tax: safeTax,
        total,
        metadata,
        items
    });
};

const mapLegacyInvoiceType = (transaction) => {
    const category = String(transaction?.category || '').toLowerCase();
    if (category === 'unlock_refund' || category === 'refund') {
        return 'REFUND_RECEIPT';
    }
    if (category === 'lock_funds' || category === 'recharge') {
        return 'DEPOSIT_RECEIPT';
    }
    if (
        category === 'campaign_payment' ||
        category === 'qr_purchase' ||
        category === 'tech_fee_charge' ||
        category === 'voucher_fee_charge'
    ) {
        return 'FEE_TAX_INVOICE';
    }
    return 'MONTHLY_STATEMENT';
};

const mapLegacyInvoiceLabel = (transaction) => {
    const category = String(transaction?.category || '').toLowerCase();
    const shortRef = transaction?.referenceId ? String(transaction.referenceId).slice(-8) : null;
    switch (category) {
        case 'campaign_payment':
            return shortRef ? `Campaign payment (${shortRef})` : 'Campaign payment';
        case 'qr_purchase':
            return shortRef ? `QR purchase (${shortRef})` : 'QR purchase';
        case 'tech_fee_charge':
            return shortRef ? `Technology fee (${shortRef})` : 'Technology fee';
        case 'voucher_fee_charge':
            return shortRef ? `Voucher fee (${shortRef})` : 'Voucher fee';
        case 'lock_funds':
            return shortRef ? `Cashback lock (${shortRef})` : 'Cashback lock';
        case 'unlock_refund':
        case 'refund':
            return shortRef ? `Refund (${shortRef})` : 'Refund';
        case 'recharge':
            return shortRef ? `Wallet recharge (${shortRef})` : 'Wallet recharge';
        default:
            return shortRef ? `Statement (${shortRef})` : 'Statement entry';
    }
};

const backfillLegacyInvoicesForVendor = async (tx, vendorId) => {
    if (!vendorId) return 0;

    const wallet = await tx.wallet.findUnique({
        where: { vendorId },
        select: { id: true }
    });

    if (!wallet?.id) return 0;

    const brand = await tx.brand.findFirst({
        where: { vendorId },
        select: { id: true }
    });

    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const categories = await getSupportedLegacyBillableCategories(tx);
    if (!categories.length) return 0;

    let transactions = [];
    try {
        transactions = await tx.transaction.findMany({
            where: {
                walletId: wallet.id,
                invoiceId: null,
                status: 'success',
                createdAt: { lt: tenMinutesAgo },
                category: {
                    in: categories
                }
            },
            orderBy: { createdAt: 'asc' },
            take: 5000
        });
    } catch (error) {
        if (isEnumInputError(error)) {
            console.error('[Invoices] Legacy backfill skipped due enum mismatch:', error.message);
            return 0;
        }
        throw error;
    }

    if (transactions.length > 0) {
        logInvoiceCreation('backfillLegacyInvoicesForVendor', { count: transactions.length, vendorId });
    } else {
        return 0;
    }

    let createdCount = 0;
    for (const txn of transactions) {
        const amount = toNumber(txn.amount, 0);
        if (amount <= 0) continue;

        const invoice = await createInvoice(tx, {
            vendorId,
            brandId: brand?.id || null,
            campaignBudgetId: txn.campaignBudgetId || null,
            type: mapLegacyInvoiceType(txn),
            subtotal: amount,
            tax: 0,
            total: amount,
            issuedAt: txn.createdAt,
            metadata: {
                source: 'legacy_transaction_backfill',
                transactionId: txn.id,
                category: txn.category,
                type: txn.type,
                referenceId: txn.referenceId || null
            },
            items: [
                {
                    label: mapLegacyInvoiceLabel(txn),
                    qty: 1,
                    unitPrice: amount,
                    amount
                }
            ]
        });

        await tx.transaction.update({
            where: { id: txn.id },
            data: { invoiceId: invoice.id }
        });
        createdCount += 1;
    }

    return createdCount;
};

const createVendorNotification = async ({ vendorId, title, message, type, metadata }) => {
    if (!vendorId) return null;
    const vendor = await prisma.vendor.findUnique({ where: { id: vendorId }, select: { userId: true } });
    if (!vendor?.userId) return null;
    return prisma.notification.create({
        data: {
            userId: vendor.userId,
            title,
            message,
            type,
            metadata
        }
    });
};

const notifyAdminsAboutPaidOrder = async ({ order, vendor, campaignTitle = 'campaign' }) => {
    if (!order) {
        console.log('[NotifyAdmins] No order provided, skipping notification');
        return;
    }

    try {
        const admins = await prisma.user.findMany({
            where: { role: 'admin' },
            select: { id: true }
        });

        console.log(`[NotifyAdmins] Found ${admins.length} admin(s) in database`);

        if (!admins.length) {
            console.log('[NotifyAdmins] No admins found, skipping notification');
            return;
        }

        const vendorLabel =
            vendor?.businessName ||
            vendor?.contactEmail ||
            vendor?.contactPhone ||
            vendor?.User?.name ||
            'Vendor';
        const shortOrderId = order.id ? order.id.slice(-6) : 'order';
        const title = `QR order paid (${vendorLabel})`;
        const message = `${vendorLabel} paid for QR order #${shortOrderId} (${order.quantity || 0} QRs for ${campaignTitle}). Please prepare the PDF.`;

        const metadata = {
            orderId: order.id,
            vendorId: vendor?.id,
            vendorLabel,
            campaignTitle,
            quantity: order.quantity,
            totalAmount: Number(order.totalAmount) || 0,
            status: order.status,
        };

        const notifications = admins.map((admin) => ({
            userId: admin.id,
            title,
            message,
            type: 'admin-order',
            metadata
        }));

        const result = await prisma.notification.createMany({
            data: notifications,
            skipDuplicates: true
        });
        console.log(`[NotifyAdmins] Created ${result.count} notification(s) for order ${shortOrderId}`);
    } catch (error) {
        console.error('[NotifyAdmins] Failed to notify admins about paid order', error);
    }
};

exports.getWalletBalance = async (req, res) => {
    try {
        const { wallet } = await ensureVendorAndWallet(req.user.id);
        const snapshot = getWalletSnapshot(wallet);
        res.json({
            ...wallet,
            ...snapshot
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching wallet', error: error.message });
    }
};

exports.rechargeWallet = async (req, res) => {
    try {
        const safeAmount = toPositiveAmount(req.body?.amount);
        if (!safeAmount) {
            return res.status(400).json({ message: 'Amount must be greater than zero' });
        }

        const result = await prisma.$transaction(async (tx) => {
            const { vendor } = await ensureVendorAndWallet(req.user.id, tx);
            const creditResult = await creditAvailable(tx, vendor.id, safeAmount, {
                category: 'recharge',
                description: 'Wallet recharge'
            });
            return {
                vendorId: vendor.id,
                wallet: creditResult.wallet
            };
        });

        safeLogVendorActivity({
            vendorId: result.vendorId,
            action: 'wallet_recharge',
            entityType: 'wallet',
            metadata: { amount: safeAmount },
            req
        });
        await createVendorNotification({
            vendorId: result.vendorId,
            title: 'Wallet recharged',
            message: `Wallet credited by INR ${safeAmount.toFixed(2)}.`,
            type: 'wallet-recharge',
            metadata: { tab: 'wallet', amount: safeAmount }
        });
        res.json({
            message: 'Wallet recharged successfully',
            wallet: {
                ...result.wallet,
                ...getWalletSnapshot(result.wallet)
            }
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: 'Recharge failed', error: error.message });
    }
};

const fundInventoryQrs = async (req, res) => {
    try {
        const { campaignId, quantity, cashbackAmount, seriesCode } = req.body;

        if (!campaignId) {
            return res.status(400).json({ message: 'Campaign ID is required' });
        }

        const parsedQuantity = parseInt(quantity, 10);
        if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
            return res.status(400).json({ message: 'Invalid quantity' });
        }

        const qrCashback = toPositiveAmount(cashbackAmount);
        if (!qrCashback) {
            return res.status(400).json({ message: 'Invalid cashback amount' });
        }

        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            include: {
                Brand: { select: { id: true, qrPricePerUnit: true, vendorId: true } }
            }
        });
        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        if (campaign.status !== 'active' || campaign.deletedAt) {
            return res.status(400).json({ message: 'Campaign is not active' });
        }

        const normalizedSeries = normalizeSeriesCode(seriesCode, null);
        const result = await prisma.$transaction(async (tx) => {
            const vendor = await requireVendorProfile(tx, req.user.id);

            if (campaign.Brand?.vendorId !== vendor.id) {
                const error = new Error('Campaign not found or unauthorized');
                error.status = 404;
                throw error;
            }

            const printCostPerQr = resolveTechFeePerQr({
                vendor,
                brand: campaign?.Brand
            });

            const cashbackTotal = toNumber(qrCashback * parsedQuantity, 0);
            const techFeeSubtotal = toNumber(printCostPerQr * parsedQuantity, 0);
            const techFeeTax = toNumber(techFeeSubtotal * INVOICE_GST_RATE, 0);
            const techFeeTotal = toNumber(techFeeSubtotal + techFeeTax, 0);

            // Voucher type fee per QR (matching payCampaign)
            const VOUCHER_FEE_MAP = { digital_voucher: 0.20, printed_qr: 0.50, none: 0 };
            const voucherFeePerQr = toNumber(VOUCHER_FEE_MAP[campaign.voucherType] || 0, 0);
            const voucherFeeSubtotal = toNumber(parsedQuantity * voucherFeePerQr, 0);
            const voucherFeeTax = toNumber(voucherFeeSubtotal * INVOICE_GST_RATE, 0);
            const voucherFeeTotal = toNumber(voucherFeeSubtotal + voucherFeeTax, 0);

            const campaignBudget = await tx.campaignBudget.create({
                data: {
                    campaignId: campaignId,
                    vendorId: vendor.id,
                    initialLockedAmount: cashbackTotal,
                    lockedAmount: cashbackTotal,
                    spentAmount: 0,
                    refundedAmount: 0,
                    status: 'active'
                }
            });

            const order = await tx.qROrder.create({
                data: {
                    vendorId: vendor.id,
                    campaignId,
                    quantity: parsedQuantity,
                    cashbackAmount: qrCashback,
                    printCost: printCostPerQr,
                    totalAmount: techFeeTotal + voucherFeeTotal,
                    status: 'paid'
                }
            });

            // Consolidate everything into one FEE_TAX_INVOICE
            const invoiceItems = [];

            // 1. Cashback Deposit (Asset)
            if (cashbackTotal > 0) {
                invoiceItems.push({
                    label: `Cashback locked for ${parsedQuantity} QRs (${campaign.title})`,
                    qty: parsedQuantity,
                    unitPrice: qrCashback,
                    amount: cashbackTotal,
                    taxRate: 0
                });
            }

            // 2. Tech Fee (Service)
            if (techFeeTotal > 0) {
                invoiceItems.push({
                    label: `QR Generation Fee for Campaign (${parsedQuantity} QRs)`,
                    qty: parsedQuantity,
                    unitPrice: printCostPerQr,
                    amount: techFeeSubtotal,
                    taxRate: INVOICE_GST_RATE * 100
                });
            }

            // 3. Voucher Fee
            if (voucherFeeTotal > 0) {
                invoiceItems.push({
                    label: `Voucher Fee (${campaign.voucherType}) for Campaign (${parsedQuantity} QRs)`,
                    qty: parsedQuantity,
                    unitPrice: voucherFeePerQr,
                    amount: voucherFeeSubtotal,
                    taxRate: INVOICE_GST_RATE * 100
                });
            }

            const sharedInvoice = await createFinanceInvoice(tx, {
                vendorId: vendor.id,
                brandId: campaign.Brand?.id,
                campaignBudgetId: campaignBudget.id,
                type: 'FEE_TAX_INVOICE',
                subtotal: cashbackTotal + techFeeSubtotal + voucherFeeSubtotal,
                tax: techFeeTax + voucherFeeTax,
                label: `Billing for QR batch (${campaign.title})`,
                items: invoiceItems,
                metadata: {
                    campaignId,
                    quantity: parsedQuantity,
                    techFeePerQr: printCostPerQr,
                    voucherFeePerQr: voucherFeePerQr,
                    cashbackPerQr: qrCashback,
                    voucherType: campaign.voucherType
                }
            });

            await chargeFee(tx, vendor.id, techFeeTotal, {
                referenceId: order.id,
                campaignBudgetId: campaignBudget.id,
                invoiceId: sharedInvoice.id,
                description: `QR Generation Fee (Consolidated) for ${campaign.title}`,
                metadata: {
                    campaignId,
                    quantity: parsedQuantity
                }
            });

            if (voucherFeeTotal > 0) {
                await chargeFee(tx, vendor.id, voucherFeeTotal, {
                    referenceId: order.id,
                    campaignBudgetId: campaignBudget.id,
                    invoiceId: sharedInvoice.id,
                    category: 'tech_fee_charge',
                    description: `Voucher Fee (Consolidated) for ${campaign.title}`,
                    metadata: {
                        campaignId,
                        quantity: parsedQuantity,
                        voucherType: campaign.voucherType
                    }
                });
            }

            await lock(tx, vendor.id, cashbackTotal, {
                referenceId: order.id,
                campaignBudgetId: campaignBudget.id,
                invoiceId: sharedInvoice.id,
                description: `Cashback locked for campaign ${campaign.title}`,
                metadata: {
                    campaignId,
                    quantity: parsedQuantity
                }
            });

            const fundedQrs = await allocateInventoryQrs(tx, {
                vendorId: vendor.id,
                campaignId,
                campaignBudgetId: campaignBudget.id,
                quantity: parsedQuantity,
                cashbackAmount: qrCashback,
                orderId: order.id,
                seriesCode: normalizedSeries
            });

            const wallet = await tx.wallet.findUnique({ where: { vendorId: vendor.id } });

            return {
                fundedCount: Number(fundedQrs?.fundedCount || 0),
                sampleQrs: Array.isArray(fundedQrs?.sampleQrs) ? fundedQrs.sampleQrs : [],
                sampled: Boolean(fundedQrs?.sampled),
                order,
                vendorId: vendor.id,
                totalCost: toNumber(cashbackTotal + techFeeTotal + voucherFeeTotal, 0),
                totalPrintCost: techFeeTotal,
                campaignTitle: campaign.title,
                quantity: parsedQuantity,
                sharedInvoice,
                invoiceId: sharedInvoice.id,
                campaignBudget,
                wallet,
                selectedSeries: normalizedSeries
            };
        }, {
            timeout: LARGE_TX_TIMEOUT_MS,
            maxWait: LARGE_TX_MAX_WAIT_MS
        });

        const orderSummary = result?.order
            ? {
                id: result.order.id,
                campaignId: result.order.campaignId,
                campaignTitle: campaign.title,
                quantity: result.order.quantity,
                cashbackAmount: Number(result.order.cashbackAmount),
                printCost: Number(result.order.printCost),
                totalAmount: Number(result.order.totalAmount),
                status: result.order.status
            }
            : null;

        res.status(201).json({
            message: 'QRs funded successfully',
            count: result.fundedCount,
            qrs: result.sampleQrs,
            sampleHashes: result.sampleQrs.map((item) => item.uniqueHash),
            sampled: result.sampled,
            order: orderSummary,
            selectedSeries: result.selectedSeries
        });

        safeLogVendorActivity({
            vendorId: result.vendorId,
            action: 'qr_order',
            entityType: 'campaign',
            entityId: campaignId,
            metadata: {
                orderId: result.order?.id,
                quantity: parsedQuantity,
                cashbackAmount: qrCashback,
                totalCost: result.totalCost,
                totalPrintCost: result.totalPrintCost,
                campaignBudgetId: result.campaignBudget?.id
            },
            req
        });

        await createVendorNotification({
            vendorId: result.vendorId,
            title: 'QRs purchased',
            message: `Debited INR ${Number(result.totalCost || 0).toFixed(2)} for ${result.quantity} QRs (${result.campaignTitle}).`,
            type: 'wallet-debit',
            metadata: {
                tab: 'wallet',
                campaignId,
                orderId: result.order?.id,
                amount: Number(result.totalCost || 0),
                quantity: result.quantity
            }
        });

        const vendorProfile = await prisma.vendor.findUnique({
            where: { id: result.vendorId },
            include: {
                User: { select: { id: true, name: true, email: true } }
            }
        });
        await notifyAdminsAboutPaidOrder({
            order: result.order,
            vendor: vendorProfile,
            campaignTitle: campaign.title
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: 'Order failed', error: error.message });
    }
};

exports.getVendorQrInventorySeries = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const requestedSeries = normalizeSeriesCode(req.query?.seriesCode, null);
        const where = {
            vendorId: vendor.id,
            status: 'inventory'
        };
        if (requestedSeries) {
            where.seriesCode = requestedSeries;
        }

        const grouped = await prisma.qRCode.groupBy({
            by: ['seriesCode'],
            where,
            _count: { _all: true },
            _min: { seriesOrder: true, importedAt: true, createdAt: true },
            _max: { seriesOrder: true, importedAt: true, createdAt: true }
        });

        const series = grouped
            .map((row) => ({
                seriesCode: row.seriesCode || 'UNASSIGNED',
                sourceBatch: null,
                availableCount: Number(row?._count?._all || 0),
                fromOrder: row?._min?.seriesOrder ?? null,
                toOrder: row?._max?.seriesOrder ?? null,
                importedAt:
                    row?._max?.importedAt ||
                    row?._max?.createdAt ||
                    row?._min?.importedAt ||
                    row?._min?.createdAt ||
                    null
            }))
            .sort((a, b) => b.availableCount - a.availableCount || a.seriesCode.localeCompare(b.seriesCode));

        const totalInventory = series.reduce((sum, item) => sum + item.availableCount, 0);

        res.json({
            totalInventory,
            series
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch QR inventory series', error: error.message });
    }
};

exports.importVendorQrInventorySeries = async (req, res) => {
    try {
        const parsedSeries = normalizeSeriesCode(req.body?.seriesCode, null);
        if (!parsedSeries) {
            return res.status(400).json({ message: 'seriesCode is required' });
        }

        let hashes = [];
        if (Array.isArray(req.body?.hashes)) {
            hashes = req.body.hashes;
        } else if (typeof req.body?.sheet === 'string') {
            hashes = req.body.sheet.split(/[\r\n,;]+/g);
        }

        const sourceBatch = req.body?.sourceBatch ? String(req.body.sourceBatch).trim() : null;

        const result = await prisma.$transaction(async (tx) => {
            const { vendor } = await ensureVendorAndWallet(req.user.id, tx);
            const importResult = await importInventorySeries(tx, {
                vendorId: vendor.id,
                seriesCode: parsedSeries,
                hashes,
                sourceBatch
            });
            return {
                vendorId: vendor.id,
                ...importResult
            };
        });

        res.status(201).json({
            message: 'QR inventory series imported',
            ...result
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: 'Failed to import QR inventory series', error: error.message });
    }
};

exports.orderQRs = fundInventoryQrs;
exports.rechargeQrInventory = fundInventoryQrs;

exports.getMyQRs = async (req, res) => {
    try {
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) return res.status(404).json({ message: 'Vendor profile not found' });

        const { page, limit, skip } = parsePagination(req, { defaultLimit: 80, maxLimit: 200 });

        const [qrs, total, statusGroups] = await Promise.all([
            prisma.qRCode.findMany({
                where: { vendorId: vendor.id },
                include: {
                    Campaign: {
                        select: {
                            id: true,
                            title: true,
                            cashbackAmount: true,
                            endDate: true,
                            status: true
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.qRCode.count({ where: { vendorId: vendor.id } }),
            prisma.qRCode.groupBy({
                by: ['status'],
                where: { vendorId: vendor.id },
                _count: { _all: true }
            })
        ]);

        const statusCounts = statusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        const formattedQrs = qrs.map(qr => ({
            ...qr,
            cashbackAmount: qr.cashbackAmount ? Number(qr.cashbackAmount) : 0,
            Campaign: qr.Campaign ? {
                ...qr.Campaign,
                cashbackAmount: qr.Campaign.cashbackAmount ? Number(qr.Campaign.cashbackAmount) : 0
            } : null
        }));

        res.json({
            items: formattedQrs,
            total,
            page,
            pages: total ? Math.ceil(total / limit) : 0,
            statusCounts
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching QRs', error: error.message });
    }
};

exports.deleteQrBatch = async (req, res) => {
    try {
        const { campaignId: bodyCampaignId, cashbackAmount: bodyCashbackAmount } = req.body || {};
        const { campaignId: queryCampaignId, cashbackAmount: queryCashbackAmount } = req.query || {};
        const campaignId = bodyCampaignId || queryCampaignId;
        const cashbackAmount = bodyCashbackAmount ?? queryCashbackAmount;

        if (!campaignId) {
            return res.status(400).json({ message: 'Campaign ID is required' });
        }

        const parsedCashback = Number(cashbackAmount);
        if (!Number.isFinite(parsedCashback) || parsedCashback < 0) {
            return res.status(400).json({ message: 'Invalid cashback amount' });
        }

        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            include: { Brand: true }
        });
        const allowNullVendor = campaign?.Brand?.vendorId === vendor.id;

        const normalizedCashback = Number(parsedCashback.toFixed(2));
        const normalizedCashbackString = normalizedCashback.toFixed(2);
        const cashbackAmountFilter =
            normalizedCashback > 0 ? { in: [normalizedCashbackString, '0.00'] } : normalizedCashbackString;
        const baseWhere = {
            campaignId,
            cashbackAmount: cashbackAmountFilter,
            ...(allowNullVendor
                ? { OR: [{ vendorId: vendor.id }, { vendorId: null }] }
                : { vendorId: vendor.id })
        };

        const totalCount = await prisma.qRCode.count({ where: baseWhere });
        if (totalCount === 0) {
            return res.status(404).json({ message: 'No QR batch found for this campaign' });
        }

        const deletableStatuses = ['generated', 'assigned', 'active'];
        const deleteWhere = {
            ...baseWhere,
            status: { in: deletableStatuses }
        };

        const deletableCount = await prisma.qRCode.count({ where: deleteWhere });
        if (deletableCount === 0) {
            return res.status(400).json({
                message: 'No deletable QRs in this batch. Redeemed/expired QRs cannot be removed.',
                total: totalCount,
                deleted: 0,
                skipped: totalCount
            });
        }

        const deleted = await prisma.qRCode.deleteMany({ where: deleteWhere });
        const skipped = totalCount - deleted.count;

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'qr_batch_delete',
            entityType: 'campaign',
            entityId: campaignId,
            metadata: {
                cashbackAmount: normalizedCashback,
                total: totalCount,
                deleted: deleted.count,
                skipped
            },
            req
        });

        res.json({
            message: `Deleted ${deleted.count} QRs from batch`,
            total: totalCount,
            deleted: deleted.count,
            skipped
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to delete QR batch', error: error.message });
    }
};

exports.getDashboardStats = async (req, res) => {
    try {
        const vendor = await prisma.vendor.findUnique({
            where: { userId: req.user.id },
            include: { Wallet: true }
        });

        if (!vendor) return res.status(404).json({ message: 'Vendor profile not found' });

        const [totalQRs, redeemedQRs, totalSpent] = await Promise.all([
            prisma.qRCode.count({ where: { vendorId: vendor.id } }),
            prisma.qRCode.count({ where: { vendorId: vendor.id, status: 'redeemed' } }),
            prisma.transaction.aggregate({
                where: {
                    walletId: vendor.Wallet.id,
                    type: 'debit'
                },
                _sum: { amount: true }
            })
        ]);

        res.json({
            wallet: {
                balance: vendor.Wallet.balance,
                currency: vendor.Wallet.currency
            },
            stats: {
                totalQRsGenerated: totalQRs,
                totalQRsRedeemed: redeemedQRs,
                totalSpent: totalSpent._sum.amount || 0
            }
        });

    } catch (error) {
        res.status(500).json({ message: 'Error fetching stats', error: error.message });
    }
};

exports.getVendorTransactions = async (req, res) => {
    try {
        const vendor = await prisma.vendor.findUnique({
            where: { userId: req.user.id },
            include: { Wallet: true }
        });

        if (!vendor) return res.status(404).json({ message: 'Vendor profile not found' });

        const transactions = await prisma.transaction.findMany({
            where: { walletId: vendor.Wallet.id },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        res.json(transactions);

    } catch (error) {
        res.status(500).json({ message: 'Error fetching transactions', error: error.message });
    }
};

exports.getVendorCampaigns = async (req, res) => {
    try {
        // Find vendor first to get ID
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) return res.json([]);

        const campaigns = await prisma.campaign.findMany({
            where: {
                Brand: {
                    vendorId: vendor.id
                },
                deletedAt: null
            },
            include: { Brand: true, Product: true },
            orderBy: { createdAt: 'desc' }
        });

        console.log(`getVendorCampaigns: Found ${campaigns.length} campaigns for vendor ${vendor.id}`);

        // Enhance active postpaid campaigns with sheet info
        const enhancedCampaigns = await Promise.all(campaigns.map(async (camp) => {
            console.log(`getVendorCampaigns: Processing campaign ${camp.id} (${camp.planType}/${camp.status})`);
            if (camp.planType === 'postpaid' && camp.status === 'active') {
                const sheets = [];
                const totalQrCount = await prisma.qRCode.count({
                    where: {
                        campaignId: camp.id,
                        status: { in: POSTPAID_SHEET_QR_STATUSES }
                    }
                });

                if (!totalQrCount) {
                    return {
                        ...camp,
                        sheets,
                        qrsPerSheet: resolvePostpaidSheetSize(0),
                        sheetCount: 0,
                        subtotal: 0,
                        totalBudget: 0
                    };
                }

                const qrsPerSheet = resolvePostpaidSheetSize(totalQrCount);
                const sheetRows = await prisma.$queryRaw`
                    WITH ordered_qrs AS (
                        SELECT
                            "status",
                            "cashbackAmount",
                            FLOOR((ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) - 1) / ${qrsPerSheet})::int AS "sheetIndex"
                        FROM "QRCode"
                        WHERE
                            "campaignId" = ${camp.id}
                            AND "status" IN ('funded', 'generated', 'active', 'assigned', 'redeemed')
                    )
                    SELECT
                        "sheetIndex",
                        COUNT(*)::int AS "count",
                        COUNT(*) FILTER (WHERE "status" IN ('funded', 'generated', 'active', 'assigned'))::int AS "updatableCount",
                        COUNT(*) FILTER (WHERE "status" = 'redeemed')::int AS "redeemedCount",
                        COALESCE(
                            MAX(CASE WHEN "status" IN ('funded', 'generated', 'active', 'assigned') THEN "cashbackAmount" END),
                            MAX("cashbackAmount"),
                            0
                        )::numeric AS "amount",
                        COALESCE(SUM("cashbackAmount"), 0)::numeric AS "sheetTotal"
                    FROM ordered_qrs
                    GROUP BY "sheetIndex"
                    ORDER BY "sheetIndex" ASC
                `;

                for (const row of sheetRows) {
                    const amount = toNumber(row?.amount, 0);
                    const sheetTotal = toNumber(row?.sheetTotal, 0);
                    const sheetIndex = Number.parseInt(row?.sheetIndex, 10) || 0;
                    const label = toRomanSheetLabel(sheetIndex + 1);
                    const count = Number.parseInt(row?.count, 10) || 0;
                    const updatableCount = Number.parseInt(row?.updatableCount, 10) || 0;
                    const redeemedCount = Number.parseInt(row?.redeemedCount, 10) || 0;

                    sheets.push({
                        index: sheetIndex,
                        label,
                        count,
                        amount,
                        updatableCount,
                        redeemedCount,
                        immutableCount: Math.max(0, count - updatableCount - redeemedCount),
                        assignedTotal: sheetTotal,
                        isPaid: false
                    });
                }

                const totalBudgetFromSheets = sheets.reduce((sum, sheet) => sum + toNumber(sheet.assignedTotal, 0), 0);

                // Enhancement: Calculate redemption counts for user-defined allocations/batches
                let enhancedAllocations = camp.allocations;
                if (Array.isArray(camp.allocations) && camp.allocations.length > 0) {
                    const allCampaignQrs = await prisma.qRCode.findMany({
                        where: { 
                            campaignId: camp.id,
                            status: { in: POSTPAID_SHEET_QR_STATUSES }
                        },
                        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                        select: { status: true }
                    });

                    let qrCursor = 0;
                    enhancedAllocations = camp.allocations.map(alloc => {
                        const quantity = Number.parseInt(alloc.quantity, 10) || 0;
                        if (quantity <= 0) return { ...alloc, redeemedCount: 0, redeemedQrs: 0 };
                        
                        const batchQrs = allCampaignQrs.slice(qrCursor, qrCursor + quantity);
                        const redeemedCount = batchQrs.filter(qr => qr.status === 'redeemed').length;
                        qrCursor += quantity;
                        
                        return { 
                            ...alloc, 
                            redeemedCount,
                            redeemedQrs: redeemedCount 
                        };
                    });
                }




                return {
                    ...camp,
                    sheets,
                    qrsPerSheet,
                    totalQrCount,
                    actualTotalQrs: totalQrCount,
                    allocations: enhancedAllocations,
                    sheetCount: resolvePostpaidSheetCount(totalQrCount),
                    subtotal: totalBudgetFromSheets,
                    totalBudget: totalBudgetFromSheets
                };
            }
            return camp;
        }));

        // console.log('Fetched Vendor Campaigns:', JSON.stringify(enhancedCampaigns, null, 2));
        res.json(enhancedCampaigns);
    } catch (error) {
        console.error('getVendorCampaigns Error:', error);
        res.status(500).json({ message: 'Error fetching campaigns', error: error.message });
    }
};

// Get Vendor Profile
exports.getVendorProfile = async (req, res) => {
    try {
        let vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) {
            // Auto-create vendor profile
            vendor = await prisma.vendor.create({
                data: {
                    userId: req.user.id,
                    businessName: 'My Company',
                    status: 'active'
                }
            });
        }
        res.json(vendor);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching vendor profile', error: error.message });
    }
};

// Get Vendor's First Brand
exports.getVendorBrand = async (req, res) => {
    try {
        const vendor = await prisma.vendor.findUnique({
            where: { userId: req.user.id },
            include: { Brand: true }
        });

        if (!vendor || !vendor.Brand) {
            return res.status(404).json({ message: 'Brand not found for this vendor' });
        }

        res.json(vendor.Brand);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching brand', error: error.message });
    }
};

exports.getVendorBrands = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const brand = await prisma.brand.findUnique({
            where: { vendorId: vendor.id }
        });
        if (!brand) {
            return res.json([]);
        }
        res.json([brand]);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching brands', error: error.message });
    }
};

// Upsert Vendor Brand (Create or Update)
exports.upsertVendorBrand = async (req, res) => {
    try {
        const { name, website, logoUrl, qrPricePerUnit } = req.body || {};
        const { vendor } = await ensureVendorAndWallet(req.user.id);

        const existingBrand = await prisma.brand.findUnique({
            where: { vendorId: vendor.id }
        });

        const payload = {
            name: typeof name === 'string' && name.trim() ? name.trim() : existingBrand?.name || vendor.businessName || 'My Brand',
            website: typeof website === 'string' && website.trim() ? website.trim() : null,
            logoUrl: typeof logoUrl === 'string' && logoUrl.trim() ? logoUrl.trim() : null,
            status: 'active'
        };

        if (qrPricePerUnit !== undefined && qrPricePerUnit !== null && qrPricePerUnit !== '') {
            payload.qrPricePerUnit = qrPricePerUnit;
        }

        const brand = existingBrand
            ? await prisma.brand.update({
                where: { id: existingBrand.id },
                data: payload
            })
            : await prisma.brand.create({
                data: {
                    ...payload,
                    vendorId: vendor.id
                }
            });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: existingBrand ? 'brand_update' : 'brand_create',
            entityType: 'brand',
            entityId: brand.id,
            metadata: {
                name: brand.name,
                website: brand.website,
                logoUrl: brand.logoUrl
            },
            req
        });

        res.json({ message: existingBrand ? 'Brand updated successfully.' : 'Brand created successfully.', brand });
    } catch (error) {
        res.status(500).json({ message: 'Failed to upsert brand', error: error.message });
    }
};

exports.updateVendorProfile = async (req, res) => {
    try {
        const {
            businessName,
            contactPhone,
            alternatePhone,
            designation,
            contactEmail,
            gstin,
            address,
            city,
            state,
            pincode
        } = req.body || {};

        // Ensure Vendor Exists (or Create it)
        let vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });

        if (!vendor) {
            vendor = await prisma.vendor.create({
                data: {
                    userId: req.user.id,
                    businessName: businessName || 'My Company',
                    contactPhone,
                    alternatePhone: alternatePhone || null,
                    designation: designation || null,
                    contactEmail: contactEmail || null,
                    gstin,
                    address: address || null,
                    city: city || null,
                    state: state || null,
                    pincode: pincode || null,
                    status: 'active'
                }
            });
        } else {
            vendor = await prisma.vendor.update({
                where: { userId: req.user.id },
                data: {
                    businessName,
                    contactPhone,
                    alternatePhone: alternatePhone !== undefined ? (alternatePhone || null) : undefined,
                    designation: designation !== undefined ? (designation || null) : undefined,
                    contactEmail: contactEmail !== undefined ? (contactEmail || null) : undefined,
                    gstin: gstin !== undefined ? (gstin || null) : undefined,
                    address: address !== undefined ? (address || null) : undefined,
                    city: city !== undefined ? (city || null) : undefined,
                    state: state !== undefined ? (state || null) : undefined,
                    pincode: pincode !== undefined ? (pincode || null) : undefined
                }
            });
        }

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'vendor_profile_update',
            entityType: 'vendor',
            entityId: vendor.id,
            metadata: {
                businessName,
                contactPhone,
                alternatePhone,
                designation,
                contactEmail,
                gstin,
                address,
                city,
                state,
                pincode
            },
            req
        });

        res.json({ message: 'Profile updated successfully', vendor });
    } catch (error) {
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

exports.requestCredentialUpdate = async (req, res) => {
    try {
        const { username, password } = req.body || {};
        const trimmedUsername = typeof username === 'string' ? username.trim() : '';
        const hasUsername = trimmedUsername.length > 0;
        const hasPassword = typeof password === 'string' && password.length > 0;

        if (!hasUsername && !hasPassword) {
            return res.status(400).json({ message: 'Provide a username or password to request an update' });
        }

        const vendor = await prisma.vendor.findUnique({
            where: { userId: req.user.id },
            include: { User: true, Brand: true }
        });

        if (!vendor || !vendor.User) {
            return res.status(404).json({ message: 'Vendor profile not found' });
        }

        if (hasUsername) {
            const existing = await prisma.user.findUnique({ where: { username: trimmedUsername } });
            if (existing && existing.id !== vendor.User.id) {
                return res.status(400).json({ message: 'Username already taken' });
            }
        }

        const updatePayload = {};
        if (hasUsername) updatePayload.requestedUsername = trimmedUsername;
        if (hasPassword) updatePayload.requestedPassword = await bcrypt.hash(password, 10);

        if (!Object.keys(updatePayload).length) {
            return res.status(400).json({ message: 'No credential updates provided' });
        }

        let request = await prisma.credentialRequest.findFirst({
            where: { vendorId: vendor.id, status: 'pending' },
            orderBy: { createdAt: 'desc' }
        });

        if (request) {
            request = await prisma.credentialRequest.update({
                where: { id: request.id },
                data: updatePayload
            });
        } else {
            request = await prisma.credentialRequest.create({
                data: {
                    vendorId: vendor.id,
                    userId: vendor.User.id,
                    ...updatePayload
                }
            });
        }

        const admins = await prisma.user.findMany({
            where: { role: 'admin' },
            select: { id: true }
        });

        if (admins.length) {
            const vendorLabel =
                vendor.businessName ||
                vendor.contactEmail ||
                vendor.User.email ||
                'Vendor';
            const notifications = admins.map((admin) => ({
                userId: admin.id,
                title: `Credential update request (${vendorLabel})`,
                message: `${vendorLabel} requested to update login credentials.`,
                type: 'credential-request',
                metadata: {
                    requestId: request.id,
                    vendorId: vendor.id,
                    brandId: vendor.Brand?.id || null,
                    vendorLabel,
                    requestedUsername: request.requestedUsername || null,
                    status: request.status
                }
            }));

            await prisma.notification.createMany({ data: notifications });
        }

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'credential_update_request',
            entityType: 'user',
            entityId: vendor.User.id,
            metadata: {
                requestedUsername: request.requestedUsername || null,
                hasPassword: Boolean(request.requestedPassword)
            },
            req
        });

        res.status(201).json({ message: 'Credential update request submitted', requestId: request.id });
    } catch (error) {
        res.status(500).json({ message: 'Failed to request credential update', error: error.message });
    }
};

exports.requestBrand = async (req, res) => {
    try {
        const { name, website, logoUrl, defaultPlanType, description, industry } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Brand name is required' });
        }

        // Auto-create Vendor and Wallet if they don't exist
        const { vendor } = await ensureVendorAndWallet(req.user.id);

        // Check if brand already exists for this vendor
        const existingBrand = await prisma.brand.findUnique({
            where: { vendorId: vendor.id }
        });

        if (existingBrand) {
            return res.status(400).json({ message: 'You already have a registered brand.' });
        }

        const brand = await prisma.brand.create({
            data: {
                name,
                website,
                logoUrl,
                // description field removed as it does not exist on Brand model
                vendorId: vendor.id,
                status: 'active',
                defaultPlanType: defaultPlanType || 'prepaid'
            }
        });

        // Log activity
        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'brand_create',
            entityType: 'brand',
            entityId: brand.id,
            metadata: { name, website },
            req
        });
        res.status(201).json({ message: 'Brand created successfully.', brand });

    } catch (error) {
        console.error('Request Brand Error:', error);
        res.status(500).json({ message: 'Failed to register brand', error: error.message });
    }
};

exports.requestCampaign = async (req, res) => {
    try {
        const {
            brandId,
            productId,
            title,
            description,
            planType,
            voucherType,
            cashbackAmount,
            startDate,
            endDate,
            totalBudget,
            subtotal,
            allocations
        } = req.body;
        console.log('Requesting Campaign Creation:', JSON.stringify(req.body, null, 2));

        // Verify ownership/status of brand
        const brand = await prisma.brand.findUnique({ where: { id: brandId } });
        if (!brand) return res.status(404).json({ message: 'Brand not found' });

        if (brand.status !== 'active') {
            return res.status(400).json({ message: 'Brand is not active' });
        }

        // Validate productId if provided
        let validProductId = null;
        if (productId) {
            const product = await prisma.product.findUnique({ where: { id: productId } });
            if (!product) {
                return res.status(404).json({ message: 'Product not found' });
            }
            if (product.brandId !== brandId) {
                return res.status(400).json({ message: 'Product does not belong to this brand' });
            }
            validProductId = productId;
        }

        const normalizedPlanType = String(planType || 'prepaid').toLowerCase() === 'postpaid'
            ? 'postpaid'
            : 'prepaid';
        const normalizedVoucherType = ['digital_voucher', 'printed_qr', 'none'].includes(String(voucherType || 'none'))
            ? String(voucherType || 'none')
            : 'none';

        const allocationRows = Array.isArray(allocations) ? allocations : [];

        const derivedSubtotal = allocationRows.reduce((sum, alloc) => {
            const quantity = parseInt(alloc?.quantity, 10) || 0;
            const cashback = parseFloat(alloc?.cashbackAmount);
            const rowTotal = parseFloat(alloc?.totalBudget);
            if (Number.isFinite(rowTotal) && rowTotal >= 0) {
                return sum + rowTotal;
            }
            if (quantity <= 0) return sum;
            if (normalizedPlanType === 'postpaid') {
                return sum;
            }
            if (Number.isFinite(cashback) && cashback > 0) {
                return sum + cashback * quantity;
            }
            return sum;
        }, 0);
        const normalizedTotalBudget = normalizedPlanType === 'postpaid'
            ? 0
            : Number.isFinite(parseFloat(totalBudget))
                ? parseFloat(totalBudget)
                : derivedSubtotal;
        const normalizedSubtotal = normalizedPlanType === 'postpaid'
            ? 0
            : Number.isFinite(parseFloat(subtotal))
                ? parseFloat(subtotal)
                : derivedSubtotal;
        const parsedCashbackAmount = parseFloat(cashbackAmount);
        const normalizedCashbackAmount = normalizedPlanType === 'postpaid'
            ? null
            : Number.isFinite(parsedCashbackAmount) && parsedCashbackAmount > 0
                ? parsedCashbackAmount
                : null;
        const campaignStatus = 'pending';

        const campaign = await prisma.campaign.create({
            data: {
                brandId,
                productId: validProductId,
                title,
                description,
                planType: normalizedPlanType,
                voucherType: normalizedVoucherType,
                cashbackAmount: normalizedCashbackAmount,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                totalBudget: normalizedTotalBudget,
                subtotal: normalizedSubtotal,
                allocations,
                status: campaignStatus
            }
        });
        safeLogVendorActivity({
            vendorId: brand.vendorId,
            action: 'campaign_create',
            entityType: 'campaign',
            entityId: campaign.id,
            metadata: {
                brandId,
                productId: validProductId,
                title,
                planType: normalizedPlanType,
                voucherType: normalizedVoucherType,
                totalBudget: normalizedTotalBudget,
                subtotal: normalizedSubtotal,
                allocationsCount: allocationRows.length
            },
            req
        });
        await createVendorNotification({
            vendorId: brand.vendorId,
            title: 'Campaign created',
            message: `Campaign "${title}" created and pending activation.`,
            type: 'campaign-created',
            metadata: { tab: 'campaigns', campaignId: campaign.id, brandId }
        });
        res.status(201).json({ message: 'Campaign created successfully', campaign });
    } catch (error) {
        console.error('Campaign Creation Error:', error);
        res.status(500).json({ message: 'Request failed', error: error.message, stack: error.stack });
    }
};


exports.updateBrand = async (_req, res) => {
    res.status(403).json({
        message: 'Brand metadata is locked to the admin panel; contact the admin for changes'
    });
};

exports.updateCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const { title, description, cashbackAmount, startDate, endDate, totalBudget, voucherType, allocations } = req.body;
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });

        const campaign = await prisma.campaign.findFirst({
            where: { id, deletedAt: null, Brand: { vendorId: vendor.id } }
        });

        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found or unauthorized' });
        }

        // Normalize voucherType
        const normalizedVoucherType = voucherType !== undefined
            ? (['digital_voucher', 'printed_qr', 'none'].includes(String(voucherType || 'none'))
                ? String(voucherType || 'none')
                : 'none')
            : undefined;

        // Process allocations if provided
        const normalizedAllocations = allocations !== undefined && Array.isArray(allocations)
            ? allocations.map(a => ({
                cashbackAmount: parseFloat(a.cashbackAmount) || 0,
                quantity: parseInt(a.quantity, 10) || 0,
                totalBudget: parseFloat(a.totalBudget) || 0
            }))
            : undefined;

        // Recalculate subtotal from allocations if provided
        let derivedSubtotal;
        if (normalizedAllocations) {
            derivedSubtotal = normalizedAllocations.reduce((sum, alloc) => {
                return sum + (alloc.totalBudget || alloc.cashbackAmount * alloc.quantity);
            }, 0);
        }

        const updateData = {
            title,
            description,
            cashbackAmount,
            startDate: startDate ? new Date(startDate) : undefined,
            endDate: endDate ? new Date(endDate) : undefined,
            totalBudget
        };

        if (normalizedVoucherType !== undefined) {
            updateData.voucherType = normalizedVoucherType;
        }
        if (normalizedAllocations !== undefined) {
            updateData.allocations = normalizedAllocations;
            updateData.subtotal = derivedSubtotal;
            updateData.totalBudget = derivedSubtotal;
        }

        const updatedCampaign = await prisma.campaign.update({
            where: { id },
            data: updateData
        });
        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'campaign_update',
            entityType: 'campaign',
            entityId: id,
            metadata: {
                title,
                cashbackAmount,
                startDate,
                endDate,
                totalBudget,
                voucherType: normalizedVoucherType
            },
            req
        });
        res.json({ message: 'Campaign updated', campaign: updatedCampaign });
    } catch (error) {
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

// --- Product Management (Vendor) ---

exports.addProduct = async (req, res) => {
    try {
        const { brandId, name, sku, mrp, variant, description, category, packSize, warranty, imageUrl } = req.body;

        // Check ownership
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        const brand = await prisma.brand.findUnique({ where: { id: brandId } });

        if (!brand || brand.vendorId !== vendor.id) {
            return res.status(403).json({ message: 'Unauthorized brand access' });
        }

        const product = await prisma.product.create({
            data: {
                brandId,
                name,
                sku: sku || null,
                mrp: mrp === undefined || mrp === null || mrp === '' ? null : mrp,
                variant,
                description,
                category,
                packSize: typeof packSize === 'string' ? packSize.trim() || null : null,
                warranty: typeof warranty === 'string' ? warranty.trim() || null : null,
                imageUrl,
                status: 'active'
            }
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'product_create',
            entityType: 'product',
            entityId: product.id,
            metadata: { brandId, name, category },
            req
        });
        res.status(201).json({ message: 'Product added', product });
    } catch (error) {
        res.status(500).json({ message: 'Error adding product', error: error.message });
    }
};

exports.importProducts = async (req, res) => {
    try {
        const { brandId, products } = req.body;

        if (!brandId) {
            return res.status(400).json({ message: 'Brand ID is required' });
        }
        if (!Array.isArray(products) || products.length === 0) {
            return res.status(400).json({ message: 'Provide at least one product to import' });
        }

        const { vendor } = await ensureVendorAndWallet(req.user.id);

        const brand = await prisma.brand.findUnique({ where: { id: brandId } });
        if (!brand || brand.vendorId !== vendor.id) {
            return res.status(403).json({ message: 'Unauthorized brand access' });
        }

        const validProducts = products
            .map((item) => {
                const statusCandidate = typeof item.status === 'string' ? item.status.toLowerCase() : '';
                const status =
                    statusCandidate === 'inactive' || statusCandidate === 'blocked' ? statusCandidate : 'active';
                return {
                    brandId,
                    name: item.name?.trim(),
                    sku: item.sku?.trim() || null,
                    mrp:
                        item.mrp === undefined || item.mrp === null || item.mrp === ''
                            ? null
                            : item.mrp,
                    variant: item.variant?.trim() || null,
                    category: item.category?.trim() || null,
                    description: item.description?.trim() || null,
                    packSize: item.packSize?.trim() || null,
                    warranty: item.warranty?.trim() || null,
                    imageUrl: item.imageUrl?.trim() || null,
                    bannerUrl: item.bannerUrl?.trim() || null,
                    status,
                };
            })
            .filter((item) => item.name);

        if (validProducts.length === 0) {
            return res.status(400).json({ message: 'No valid products found to import' });
        }

        const result = await prisma.product.createMany({
            data: validProducts,
            skipDuplicates: true
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'product_import',
            entityType: 'brand',
            entityId: brandId,
            metadata: {
                requested: products.length,
                imported: result.count
            },
            req
        });
        res.status(201).json({
            message: `${result.count} products imported`,
            count: result.count
        });
    } catch (error) {
        res.status(500).json({ message: 'Error importing products', error: error.message });
    }
};

exports.getVendorProducts = async (req, res) => {
    try {
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) {
            return res.json([]);
        }

        const products = await prisma.product.findMany({
            where: {
                Brand: { vendorId: vendor.id },
                deletedAt: null
            },
            select: {
                id: true,
                brandId: true,
                name: true,
                sku: true,
                mrp: true,
                variant: true,
                category: true,
                description: true,
                packSize: true,
                warranty: true,
                imageUrl: true,
                bannerUrl: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                Brand: { select: { name: true } }
            },
            orderBy: { createdAt: 'desc' }
        });

        // Keep pricing consistently numeric for the frontend table.
        res.json(
            products.map((product) => ({
                ...product,
                mrp: product.mrp !== null && product.mrp !== undefined ? Number(product.mrp) : null
            }))
        );
    } catch (error) {
        res.status(500).json({ message: 'Error fetching products', error: error.message });
    }
};

exports.updateProduct = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, sku, mrp, variant, description, category, packSize, warranty, imageUrl, status } = req.body;
        const hasSku = Object.prototype.hasOwnProperty.call(req.body || {}, 'sku');
        const hasMrp = Object.prototype.hasOwnProperty.call(req.body || {}, 'mrp');
        const hasPackSize = Object.prototype.hasOwnProperty.call(req.body || {}, 'packSize');
        const hasWarranty = Object.prototype.hasOwnProperty.call(req.body || {}, 'warranty');

        // Verify ownership
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        const product = await prisma.product.findFirst({
            where: { id, deletedAt: null, Brand: { vendorId: vendor.id } }
        });

        if (!product) return res.status(404).json({ message: 'Product not found or unauthorized' });

        const data = {
            name,
            variant,
            description,
            category,
            imageUrl,
            status
        };

        if (hasSku) {
            data.sku = typeof sku === 'string' ? sku.trim() || null : null;
        }
        if (hasMrp) {
            if (mrp === undefined || mrp === null || mrp === '') {
                data.mrp = null;
            } else {
                const parsedMrp = Number(mrp);
                data.mrp = Number.isFinite(parsedMrp) ? parsedMrp : null;
            }
        }
        if (hasPackSize) {
            data.packSize = typeof packSize === 'string' ? packSize.trim() || null : null;
        }
        if (hasWarranty) {
            data.warranty = typeof warranty === 'string' ? warranty.trim() || null : null;
        }

        const updated = await prisma.product.update({
            where: { id },
            data
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'product_update',
            entityType: 'product',
            entityId: id,
            metadata: { name, category, status },
            req
        });
        res.json({ message: 'Product updated', product: updated });
    } catch (error) {
        res.status(500).json({ message: 'Error updating product', error: error.message });
    }
};

const cancelCampaignWithRefund = async (tx, { campaignId, vendorId, reason = 'Campaign cancelled by vendor' }) => {
    const campaign = await tx.campaign.findUnique({
        where: { id: campaignId },
        include: {
            Brand: { select: { id: true, vendorId: true } }
        }
    });

    if (!campaign || campaign.Brand?.vendorId !== vendorId) {
        const error = new Error('Campaign not found or unauthorized');
        error.status = 404;
        throw error;
    }

    const activeBudgets = await tx.campaignBudget.findMany({
        where: {
            campaignId,
            vendorId,
            status: 'active'
        },
        orderBy: { createdAt: 'asc' }
    });

    const refundableAmount = toNumber(
        activeBudgets.reduce((sum, budget) => sum + Number(budget.lockedAmount || 0), 0),
        0
    );

    let refundInvoice = null;
    if (refundableAmount > 0) {
        refundInvoice = await createFinanceInvoice(tx, {
            vendorId,
            brandId: campaign.Brand?.id,
            campaignBudgetId: activeBudgets[0]?.id || null,
            type: 'REFUND_RECEIPT',
            subtotal: refundableAmount,
            tax: 0,
            label: `Locked cashback refund for ${campaign.title}`,
            metadata: {
                campaignId,
                reason,
                budgetIds: activeBudgets.map((budget) => budget.id)
            }
        });

        await unlockRefund(tx, vendorId, refundableAmount, {
            referenceId: campaignId,
            campaignBudgetId: activeBudgets[0]?.id || null,
            invoiceId: refundInvoice.id,
            description: `Refund unlocked for cancelled campaign "${campaign.title}"`,
            metadata: {
                campaignId,
                reason
            }
        });
    }

    for (const budget of activeBudgets) {
        const lockedAmount = Number(budget.lockedAmount || 0);
        await tx.campaignBudget.update({
            where: { id: budget.id },
            data: {
                refundedAmount: {
                    increment: lockedAmount
                },
                lockedAmount: 0,
                status: 'refunded'
            }
        });
    }

    const voidedResult = await tx.qRCode.updateMany({
        where: {
            campaignId,
            status: {
                in: ['funded', 'generated', 'assigned', 'active']
            }
        },
        data: {
            status: 'void',
            campaignId: null,
            campaignBudgetId: null
        }
    });

    // Clean up any BulkExportJob records linked to this campaign (skip if model/table not available)
    if (tx.bulkExportJob) {
        await tx.bulkExportJob.deleteMany({ where: { campaignId } }).catch(() => { });
    }

    const updatedCampaign = await tx.campaign.update({
        where: { id: campaignId },
        data: {
            status: 'completed',
            deletedAt: new Date(),
            rejectionReason: reason
        }
    });

    return {
        campaign: updatedCampaign,
        refundedAmount: refundableAmount,
        refundInvoice,
        voidedCount: voidedResult.count
    };
};

exports.deleteProduct = async (req, res) => {
    try {
        const { id } = req.params;

        // Verify ownership
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        const product = await prisma.product.findFirst({
            where: { id, deletedAt: null, Brand: { vendorId: vendor.id } }
        });

        if (!product) return res.status(404).json({ message: 'Product not found or unauthorized' });

        const campaigns = await prisma.campaign.findMany({
            where: {
                productId: id,
                deletedAt: null
            },
            select: { id: true, title: true }
        });
        const campaignIds = campaigns.map((campaign) => campaign.id);

        const cancellationResult = await prisma.$transaction(async (tx) => {
            let totalRefunded = 0;
            let totalVoided = 0;
            const cancelledCampaigns = [];

            for (const campaign of campaigns) {
                const cancelled = await cancelCampaignWithRefund(tx, {
                    campaignId: campaign.id,
                    vendorId: vendor.id,
                    reason: `Product ${product.name} deleted by vendor`
                });
                totalRefunded += Number(cancelled.refundedAmount || 0);
                totalVoided += Number(cancelled.voidedCount || 0);
                cancelledCampaigns.push({
                    id: campaign.id,
                    title: campaign.title,
                    refundedAmount: Number(cancelled.refundedAmount || 0),
                    voidedQrs: Number(cancelled.voidedCount || 0)
                });
            }

            const updatedProduct = await tx.product.update({
                where: { id },
                data: {
                    status: 'inactive',
                    deletedAt: new Date()
                }
            });

            return {
                totalRefunded: toNumber(totalRefunded, 0),
                totalVoided,
                cancelledCampaigns,
                product: updatedProduct
            };
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'product_delete',
            entityType: 'product',
            entityId: id,
            metadata: {
                name: product.name,
                deletedCampaigns: campaignIds.length,
                refundedAmount: cancellationResult.totalRefunded,
                voidedQrs: cancellationResult.totalVoided
            },
            req
        });
        res.json({
            message: 'Product deleted and campaign funds refunded',
            productId: id,
            refundedAmount: cancellationResult.totalRefunded,
            voidedQrs: cancellationResult.totalVoided,
            cancelledCampaigns: cancellationResult.cancelledCampaigns
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: 'Error deleting product', error: error.message });
    }
};

// --- Analytics ---

exports.getCampaignStats = async (req, res) => {
    try {
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

        const stats = await prisma.campaign.findMany({
            where: {
                Brand: { vendorId: vendor.id },
                deletedAt: null
            }, // All campaigns for this vendor
            select: {
                id: true,
                title: true,
                status: true,
                totalBudget: true,
                _count: {
                    select: { QRCodes: true } // Total QRs generated
                },
                QRCodes: {
                    where: { status: 'redeemed' }, // Only count redeemed for engagement
                    select: { id: true }
                }
            }
        });

        // Format
        const formatted = stats.map(c => ({
            id: c.id,
            campaign: c.title,
            status: c.status,
            budget: c.totalBudget,
            totalQRsOrdered: c._count.QRCodes,
            totalUsersJoined: c.QRCodes.length,
            budgetSpent: c.QRCodes.length * 0 // Access cashback amount if needed, simplifying
        }));

        res.json(formatted);

    } catch (error) {
        res.status(500).json({ message: 'Error fetching stats', error: error.message });
    }
};

// --- Campaign Control & Cleanup ---

exports.updateCampaignStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // 'active', 'paused'
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });

        if (!['active', 'paused'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Use active or paused.' });
        }

        const campaign = await prisma.campaign.findFirst({
            where: { id, Brand: { vendorId: vendor.id } }
        });

        if (!campaign) return res.status(404).json({ message: 'Campaign not found' });

        // Prevent resuming if rejected/completed?
        // For now, allow toggling active/paused.

        const updated = await prisma.campaign.update({
            where: { id },
            data: { status }
        });
        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'campaign_status_update',
            entityType: 'campaign',
            entityId: id,
            metadata: { status },
            req
        });
        res.json({ message: `Campaign ${status}`, campaign: updated });

    } catch (error) {
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

exports.deleteBrand = async (_req, res) => {
    res.status(403).json({
        message: 'Brand deletion is restricted to administrators'
    });
};

exports.deleteCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) return res.status(404).json({ message: 'Vendor profile not found' });

        const result = await prisma.$transaction(async (tx) => {
            return cancelCampaignWithRefund(tx, {
                campaignId: id,
                vendorId: vendor.id,
                reason: 'Campaign deleted by vendor'
            });
        }, {
            timeout: 120000,
            maxWait: 10000
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'campaign_delete',
            entityType: 'campaign',
            entityId: id,
            metadata: {
                title: result.campaign?.title,
                refundedAmount: Number(result.refundedAmount || 0),
                voidedQrs: Number(result.voidedCount || 0)
            },
            req
        });

        res.json({
            message: 'Campaign deleted and locked funds refunded',
            campaignId: id,
            refundedAmount: Number(result.refundedAmount || 0),
            voidedQrs: Number(result.voidedCount || 0)
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: 'Delete failed', error: error.message });
    }
};

// --- QR Order Management ---

exports.getVendorOrders = async (req, res) => {
    try {
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) return res.status(404).json({ message: 'Vendor profile not found' });

        const { page, limit, skip } = parsePagination(req, { defaultLimit: 20, maxLimit: 100 });

        const [orders, total, statusGroups] = await Promise.all([
            prisma.qROrder.findMany({
                where: { vendorId: vendor.id },
                include: {
                    _count: { select: { QRCodes: true } }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.qROrder.count({ where: { vendorId: vendor.id } }),
            prisma.qROrder.groupBy({
                by: ['status'],
                where: { vendorId: vendor.id },
                _count: { _all: true }
            })
        ]);

        const statusCounts = statusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        const campaignIds = [...new Set(orders.map(o => o.campaignId))];
        const campaigns = await prisma.campaign.findMany({
            where: { id: { in: campaignIds } },
            select: { id: true, title: true }
        });
        const campaignMap = Object.fromEntries(campaigns.map(c => [c.id, c.title]));

        const formattedOrders = orders.map(order => ({
            id: order.id,
            campaignId: order.campaignId,
            campaignTitle: campaignMap[order.campaignId] || 'Unknown Campaign',
            quantity: order.quantity,
            cashbackAmount: Number(order.cashbackAmount),
            printCost: Number(order.printCost),
            totalAmount: Number(order.totalAmount),
            status: order.status,
            createdAt: order.createdAt,
            qrCount: order._count?.QRCodes || 0
        }));

        res.json({
            items: formattedOrders,
            total,
            page,
            pages: total ? Math.ceil(total / limit) : 0,
            statusCounts
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching orders', error: error.message });
    }
};

exports.createOrder = async (req, res) => {
    try {
        const { campaignId, quantity, cashbackAmount } = req.body;

        if (!campaignId) {
            return res.status(400).json({ message: 'Campaign ID is required' });
        }

        const parsedQuantity = parseInt(quantity, 10);
        if (!Number.isFinite(parsedQuantity) || parsedQuantity <= 0) {
            return res.status(400).json({ message: 'Invalid quantity' });
        }

        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            include: {
                Brand: { select: { qrPricePerUnit: true } }
            }
        });
        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        if (campaign.status !== 'active') {
            return res.status(400).json({ message: 'Campaign is not active' });
        }

        const rawCashback = cashbackAmount ?? campaign.cashbackAmount;
        const qrCashback = parseFloat(rawCashback);
        if (isNaN(qrCashback) || qrCashback <= 0) {
            return res.status(400).json({ message: 'Invalid cashback amount' });
        }

        const vendor = await requireVendorProfile(prisma, req.user.id);
        const printCostPerQr = resolveTechFeePerQr({
            vendor,
            brand: campaign?.Brand
        });
        const totalPrintCost = printCostPerQr * parsedQuantity;

        // Create order (status: pending)
        const order = await prisma.qROrder.create({
            data: {
                vendorId: vendor.id,
                campaignId,
                quantity: parsedQuantity,
                cashbackAmount: qrCashback,
                printCost: printCostPerQr,
                totalAmount: totalPrintCost,
                status: 'pending'
            }
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'qr_order_create',
            entityType: 'campaign',
            entityId: campaignId,
            metadata: {
                orderId: order.id,
                quantity: parsedQuantity,
                cashbackAmount: qrCashback,
                totalAmount: totalPrintCost
            },
            req
        });
        res.status(201).json({
            message: 'Order created. Please pay to confirm.',
            order: {
                id: order.id,
                campaignTitle: campaign.title,
                quantity: order.quantity,
                cashbackAmount: Number(order.cashbackAmount),
                printCost: Number(order.printCost),
                totalAmount: Number(order.totalAmount),
                status: order.status
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Order creation failed', error: error.message });
    }
};

exports.payOrder = async (req, res) => {
    try {
        const { orderId } = req.params;
        const requestedSeries = normalizeSeriesCode(req.body?.seriesCode, null);

        const order = await prisma.qROrder.findUnique({ where: { id: orderId } });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        if (order.status !== 'pending') {
            return res.status(400).json({ message: `Order already ${order.status}` });
        }

        const result = await prisma.$transaction(async (tx) => {
            const vendor = await requireVendorProfile(tx, req.user.id);
            if (order.vendorId !== vendor.id) {
                const error = new Error('Unauthorized');
                error.status = 403;
                throw error;
            }

            const campaign = await tx.campaign.findUnique({
                where: { id: order.campaignId },
                include: {
                    Brand: { select: { id: true, vendorId: true, qrPricePerUnit: true } }
                }
            });
            // Ensure we have voucherType
            const campWithVoucher = await tx.campaign.findUnique({
                where: { id: order.campaignId },
                select: { voucherType: true }
            });
            const voucherType = campWithVoucher?.voucherType || 'none';
            if (!campaign || campaign.Brand?.vendorId !== vendor.id || campaign.deletedAt) {
                const error = new Error('Campaign not found or unauthorized');
                error.status = 404;
                throw error;
            }
            if (campaign.status !== 'active') {
                const error = new Error('Campaign must be active before paying order');
                error.status = 400;
                throw error;
            }

            const quantity = Number.parseInt(order.quantity, 10);
            const qrCashback = toPositiveAmount(order.cashbackAmount);
            if (!Number.isFinite(quantity) || quantity <= 0 || !qrCashback) {
                const error = new Error('Order contains invalid quantity or cashback');
                error.status = 400;
                throw error;
            }

            const printCostPerQr = Number(order.printCost || resolveTechFeePerQr({ vendor, brand: campaign.Brand }));
            const techFeeSubtotal = toNumber(printCostPerQr * quantity, 0);
            const techFeeTax = toNumber(techFeeSubtotal * INVOICE_GST_RATE, 0);
            const techFeeTotal = toNumber(techFeeSubtotal + techFeeTax, 0);

            // Voucher type fee per QR (matching payCampaign)
            const VOUCHER_FEE_MAP = { digital_voucher: 0.20, printed_qr: 0.50, none: 0 };
            const voucherFeePerQr = toNumber(VOUCHER_FEE_MAP[voucherType] || 0, 0);
            const voucherFeeSubtotal = toNumber(quantity * voucherFeePerQr, 0);
            const voucherFeeTax = toNumber(voucherFeeSubtotal * INVOICE_GST_RATE, 0);
            const voucherFeeTotal = toNumber(voucherFeeSubtotal + voucherFeeTax, 0);

            const cashbackTotal = toNumber(qrCashback * quantity, 0);

            const campaignBudget = await tx.campaignBudget.create({
                data: {
                    campaignId: campaign.id,
                    vendorId: vendor.id,
                    initialLockedAmount: cashbackTotal,
                    lockedAmount: cashbackTotal,
                    spentAmount: 0,
                    refundedAmount: 0,
                    status: 'active'
                }
            });

            // Consolidate everything into one FEE_TAX_INVOICE
            const invoiceItems = [];

            // 1. Cashback Deposit
            if (cashbackTotal > 0) {
                invoiceItems.push({
                    label: `Cashback locked for order #${order.id.slice(-6)}`,
                    qty: quantity,
                    unitPrice: qrCashback,
                    amount: cashbackTotal,
                    taxRate: 0
                });
            }

            // 2. Tech Fee
            if (techFeeTotal > 0) {
                invoiceItems.push({
                    label: `Technology fee for order #${order.id.slice(-6)}`,
                    qty: quantity,
                    unitPrice: printCostPerQr,
                    amount: techFeeSubtotal,
                    taxRate: INVOICE_GST_RATE * 100
                });
            }

            // 3. Voucher Fee
            if (voucherFeeTotal > 0) {
                invoiceItems.push({
                    label: `Voucher fee (${voucherType}) for order #${order.id.slice(-6)}`,
                    qty: quantity,
                    unitPrice: voucherFeePerQr,
                    amount: voucherFeeSubtotal,
                    taxRate: INVOICE_GST_RATE * 100
                });
            }

            const sharedInvoice = await createFinanceInvoice(tx, {
                vendorId: vendor.id,
                brandId: campaign.Brand?.id,
                campaignBudgetId: campaignBudget.id,
                type: 'FEE_TAX_INVOICE',
                subtotal: cashbackTotal + techFeeSubtotal + voucherFeeSubtotal,
                tax: techFeeTax + voucherFeeTax,
                label: `Billing for QR order #${order.id.slice(-6)}`,
                items: invoiceItems,
                metadata: {
                    campaignId: campaign.id,
                    orderId: order.id,
                    quantity,
                    techFeePerQr: printCostPerQr,
                    voucherFeePerQr: voucherFeePerQr,
                    cashbackPerQr: qrCashback,
                    voucherType
                }
            });

            if (techFeeTotal > 0) {
                await chargeFee(tx, vendor.id, techFeeTotal, {
                    referenceId: order.id,
                    campaignBudgetId: campaignBudget.id,
                    invoiceId: sharedInvoice.id,
                    description: `Technology fee for QR order #${order.id.slice(-6)}`,
                    metadata: { campaignId: campaign.id, quantity }
                });
            }

            if (voucherFeeTotal > 0) {
                await chargeFee(tx, vendor.id, voucherFeeTotal, {
                    referenceId: order.id,
                    campaignBudgetId: campaignBudget.id,
                    invoiceId: sharedInvoice.id,
                    category: 'tech_fee_charge',
                    description: `Voucher fee (${voucherType}) for QR order #${order.id.slice(-6)}`,
                    metadata: { campaignId: campaign.id, quantity, voucherType }
                });
            }

            if (cashbackTotal > 0) {
                await lock(tx, vendor.id, cashbackTotal, {
                    referenceId: order.id,
                    campaignBudgetId: campaignBudget.id,
                    invoiceId: sharedInvoice.id,
                    description: `Cashback locked for QR order #${order.id.slice(-6)}`,
                    metadata: { campaignId: campaign.id, quantity }
                });
            }

            const fundedQrs = await allocateInventoryQrs(tx, {
                vendorId: vendor.id,
                campaignId: campaign.id,
                campaignBudgetId: campaignBudget.id,
                quantity,
                cashbackAmount: qrCashback,
                orderId: order.id,
                seriesCode: requestedSeries
            });

            const updatedOrder = await tx.qROrder.update({
                where: { id: order.id },
                data: {
                    status: 'paid',
                    printCost: printCostPerQr,
                    totalAmount: techFeeTotal
                }
            });

            return {
                vendorId: vendor.id,
                campaignTitle: campaign.title,
                order: updatedOrder,
                totalPaid: toNumber(techFeeTotal + cashbackTotal, 0),
                selectedSeries: requestedSeries,
                fundedCount: Number(fundedQrs?.fundedCount || 0)
            };
        }, {
            timeout: LARGE_TX_TIMEOUT_MS,
            maxWait: LARGE_TX_MAX_WAIT_MS
        });

        await notifyAdminsAboutPaidOrder({
            order: result.order,
            vendor: { id: result.vendorId },
            campaignTitle: result.campaignTitle
        });

        await createVendorNotification({
            vendorId: result.vendorId,
            title: 'QR order paid',
            message: `Debited INR ${Number(result.totalPaid).toFixed(2)} for QR order #${result.order.id.slice(-6)} (${result.campaignTitle}).`,
            type: 'wallet-debit',
            metadata: {
                tab: 'wallet',
                orderId: result.order.id,
                campaignId: result.order.campaignId,
                amount: Number(result.totalPaid)
            }
        });

        res.json({
            message: 'Payment successful. QRs funded from inventory.',
            order: {
                id: result.order.id,
                status: result.order.status,
                quantity: result.order.quantity,
                fundedCount: result.fundedCount,
                totalPaid: result.totalPaid,
                selectedSeries: result.selectedSeries
            }
        });

        safeLogVendorActivity({
            vendorId: result.vendorId,
            action: 'qr_order_pay',
            entityType: 'order',
            entityId: result.order.id,
            metadata: {
                campaignId: result.order.campaignId,
                quantity: result.order.quantity,
                totalPaid: result.totalPaid,
                selectedSeries: result.selectedSeries
            },
            req
        });
    } catch (error) {
        res.status(error.status || 500).json({ message: 'Payment failed', error: error.message });
    }
};



exports.payCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const requestedSeries = normalizeSeriesCode(req.body?.seriesCode, null);

        const result = await prisma.$transaction(async (tx) => {
            const vendor = await requireVendorProfile(tx, req.user.id);

            let campaign = await tx.campaign.findUnique({
                where: { id },
                include: {
                    Brand: { select: { id: true, qrPricePerUnit: true, vendorId: true } }
                }
            });
            if (!campaign || campaign.Brand?.vendorId !== vendor.id) {
                const error = new Error('Campaign not found');
                error.status = 404;
                throw error;
            }

            if (campaign.deletedAt) {
                const error = new Error('Campaign has been deleted');
                error.status = 400;
                throw error;
            }

            if (campaign.status === 'active') {
                const error = new Error('Campaign is already active');
                error.status = 400;
                throw error;
            }

            const hasAllocationOverride = Array.isArray(req.body?.allocations);
            const allocArray = hasAllocationOverride
                ? req.body.allocations
                : Array.isArray(campaign.allocations)
                    ? campaign.allocations
                    : [];
            const hasVoucherTypeOverride = Object.prototype.hasOwnProperty.call(req.body || {}, 'voucherType');
            const effectiveVoucherType = normalizeVoucherType(
                hasVoucherTypeOverride ? req.body?.voucherType : campaign.voucherType,
                normalizeVoucherType(campaign.voucherType, 'none')
            );

            const hasAnyQtyRow = allocArray.some((alloc) => (Number.parseInt(alloc?.quantity, 10) || 0) > 0);
            const hasPositiveCashbackRow = allocArray.some((alloc) => {
                const quantity = Number.parseInt(alloc?.quantity, 10) || 0;
                const cashback = toPositiveAmount(alloc?.cashbackAmount) || 0;
                return quantity > 0 && cashback > 0;
            });
            const inferredPostpaidCampaign =
                campaign.planType !== 'postpaid' &&
                hasAnyQtyRow &&
                !hasPositiveCashbackRow &&
                toNumber(campaign.subtotal, 0) <= 0 &&
                toNumber(campaign.totalBudget, 0) <= 0 &&
                !toPositiveAmount(campaign.cashbackAmount);
            const isPostpaidCampaign = campaign.planType === 'postpaid' || inferredPostpaidCampaign;
            const normalizedRows = normalizeAllocationRows(allocArray, {
                isPostpaid: isPostpaidCampaign
            });

            if (!normalizedRows.length) {
                const error = new Error('Campaign has no valid allocations to fund');
                error.status = 400;
                throw error;
            }

            if (hasAllocationOverride || hasVoucherTypeOverride || inferredPostpaidCampaign) {
                const normalizedAllocations = normalizedRows.map((row) => ({
                    cashbackAmount: row.cashbackAmount,
                    quantity: row.quantity,
                    totalBudget: row.totalBudget
                }));
                const allocationBudgetTotal = isPostpaidCampaign
                    ? 0
                    : toNumber(
                        normalizedAllocations.reduce((sum, row) => sum + Number(row.totalBudget || 0), 0),
                        0
                    );
                const nextPlanType = inferredPostpaidCampaign ? 'postpaid' : campaign.planType;
                const updateData = {};

                if (hasAllocationOverride) {
                    updateData.allocations = normalizedAllocations;
                    updateData.subtotal = allocationBudgetTotal;
                    updateData.totalBudget = allocationBudgetTotal;
                }
                if (hasVoucherTypeOverride) {
                    updateData.voucherType = effectiveVoucherType;
                }
                if (nextPlanType !== campaign.planType) {
                    updateData.planType = nextPlanType;
                }

                if (Object.keys(updateData).length) {
                    await tx.campaign.update({
                        where: { id: campaign.id },
                        data: updateData
                    });
                    campaign = {
                        ...campaign,
                        ...updateData
                    };
                }
            }

            const totalQty = normalizedRows.reduce((sum, row) => sum + row.quantity, 0);
            const cashbackTotal = toNumber(
                normalizedRows.reduce((sum, row) => sum + row.quantity * row.cashbackAmount, 0),
                0
            );
            const printCostPerQr = resolveTechFeePerQr({
                vendor,
                brand: campaign?.Brand
            });
            const techFeeSubtotal = toNumber(totalQty * printCostPerQr, 0);
            const techFeeTax = toNumber(techFeeSubtotal * INVOICE_GST_RATE, 0);
            const techFeeTotal = toNumber(techFeeSubtotal + techFeeTax, 0);

            // Voucher type fee per QR
            const VOUCHER_FEE_MAP = { digital_voucher: 0.20, printed_qr: 0.50, none: 0 };
            const voucherFeePerQr = toNumber(VOUCHER_FEE_MAP[effectiveVoucherType] || 0, 0);
            const voucherFeeSubtotal = toNumber(totalQty * voucherFeePerQr, 0);
            const voucherFeeTax = toNumber(voucherFeeSubtotal * INVOICE_GST_RATE, 0);
            const voucherFeeTotal = toNumber(voucherFeeSubtotal + voucherFeeTax, 0);

            const totalCost = toNumber(cashbackTotal + techFeeTotal + voucherFeeTotal, 0);

            const campaignBudget = await tx.campaignBudget.create({
                data: {
                    campaignId: campaign.id,
                    vendorId: vendor.id,
                    initialLockedAmount: cashbackTotal,
                    lockedAmount: cashbackTotal,
                    spentAmount: 0,
                    refundedAmount: 0,
                    status: 'active'
                }
            });

            // Consolidate everything into one FEE_TAX_INVOICE
            const invoiceItems = [];

            // 1. Cashback Deposit (if any)
            if (cashbackTotal > 0) {
                invoiceItems.push({
                    label: `Cashback locked for campaign ${campaign.title}`,
                    qty: totalQty,
                    unitPrice: isPostpaidCampaign ? 0 : (cashbackTotal / totalQty),
                    amount: cashbackTotal,
                    taxRate: 0
                });
            }

            // 2. Tech Fee
            if (techFeeTotal > 0) {
                invoiceItems.push({
                    label: `Technology fee for ${totalQty} QRs`,
                    qty: totalQty,
                    unitPrice: printCostPerQr,
                    amount: techFeeSubtotal,
                    taxRate: INVOICE_GST_RATE * 100
                });
            }

            // 3. Voucher Fee
            if (voucherFeeTotal > 0) {
                invoiceItems.push({
                    label: `Voucher fee (${effectiveVoucherType}) for ${totalQty} QRs`,
                    qty: totalQty,
                    unitPrice: voucherFeePerQr,
                    amount: voucherFeeSubtotal,
                    taxRate: INVOICE_GST_RATE * 100
                });
            }

            const sharedInvoice = await createFinanceInvoice(tx, {
                vendorId: vendor.id,
                brandId: campaign.Brand?.id,
                campaignBudgetId: campaignBudget.id,
                type: 'FEE_TAX_INVOICE',
                subtotal: cashbackTotal + techFeeSubtotal + voucherFeeSubtotal,
                tax: techFeeTax + voucherFeeTax,
                label: `Billing for campaign ${campaign.title}`,
                items: invoiceItems,
                metadata: {
                    campaignId: campaign.id,
                    quantity: totalQty,
                    techFeePerQr: printCostPerQr,
                    voucherFeePerQr: voucherFeePerQr,
                    cashbackPerQr: isPostpaidCampaign ? 0 : (cashbackTotal / totalQty),
                    voucherType: effectiveVoucherType
                }
            });

            // Wallet operations linked to sharedInvoice
            if (techFeeTotal > 0) {
                await chargeFee(tx, vendor.id, techFeeTotal, {
                    referenceId: campaign.id,
                    campaignBudgetId: campaignBudget.id,
                    invoiceId: sharedInvoice.id,
                    description: `Technology fee for campaign ${campaign.title}`,
                    metadata: { campaignId: campaign.id, quantity: totalQty }
                });
            }

            if (cashbackTotal > 0) {
                await lock(tx, vendor.id, cashbackTotal, {
                    referenceId: campaign.id,
                    campaignBudgetId: campaignBudget.id,
                    invoiceId: sharedInvoice.id,
                    description: `Cashback locked for campaign ${campaign.title}`,
                    metadata: {
                        campaignId: campaign.id,
                        quantity: totalQty,
                        cashbackAmount: isPostpaidCampaign ? 0 : (cashbackTotal / totalQty)
                    }
                });
            }

            if (voucherFeeTotal > 0) {
                await chargeFee(tx, vendor.id, voucherFeeTotal, {
                    referenceId: campaign.id,
                    campaignBudgetId: campaignBudget.id,
                    invoiceId: sharedInvoice.id,
                    category: 'tech_fee_charge',
                    description: `Voucher fee (${effectiveVoucherType}) for campaign ${campaign.title}`,
                    metadata: {
                        campaignId: campaign.id,
                        quantity: totalQty,
                        voucherType: effectiveVoucherType
                    }
                });
            }

            let fundedCount = 0;
            for (const row of normalizedRows) {
                const fundedQrs = await allocateInventoryQrs(tx, {
                    vendorId: vendor.id,
                    campaignId: campaign.id,
                    campaignBudgetId: campaignBudget.id,
                    quantity: row.quantity,
                    cashbackAmount: row.cashbackAmount,
                    orderId: null,
                    seriesCode: requestedSeries
                });
                fundedCount += Number(fundedQrs?.fundedCount || 0);
            }

            await tx.campaign.update({
                where: { id: campaign.id },
                data: { status: 'active' }
            });

            return {
                vendorId: vendor.id,
                campaignId: campaign.id,
                campaignTitle: campaign.title,
                totalCost,
                totalQty,
                printCost: techFeeTotal,
                voucherCost: voucherFeeTotal,
                baseBudget: cashbackTotal,
                fundedCount,
                selectedSeries: requestedSeries
            };
        }, {
            timeout: LARGE_TX_TIMEOUT_MS,
            maxWait: LARGE_TX_MAX_WAIT_MS
        });

        safeLogVendorActivity({
            vendorId: result.vendorId,
            action: 'campaign_pay',
            entityType: 'campaign',
            entityId: id,
            metadata: {
                totalCost: result.totalCost,
                totalQty: result.totalQty,
                printCost: result.printCost,
                baseBudget: result.baseBudget,
                fundedCount: result.fundedCount,
                selectedSeries: result.selectedSeries
            },
            req
        });
        await createVendorNotification({
            vendorId: result.vendorId,
            title: 'Campaign activated',
            message: `Debited INR ${Number(result.totalCost).toFixed(2)} to activate campaign "${result.campaignTitle}".`,
            type: 'wallet-debit',
            metadata: {
                tab: 'campaigns',
                campaignId: result.campaignId,
                amount: Number(result.totalCost),
                fundedCount: result.fundedCount,
                selectedSeries: result.selectedSeries
            }
        });

        // Send payment success response immediately — don't block on export queue
        res.json({
            message: 'Campaign payment successful. Campaign is now active.',
            fundedCount: result.fundedCount,
            selectedSeries: result.selectedSeries
        });

        // Fire-and-forget: queue bulk QR PDF export in background (after response is sent)
        setImmediate(() => {
            queueCampaignExportJob({
                vendorId: result.vendorId,
                campaignId: result.campaignId,
                splitParts: true,
                requestedByUserId: req.user.id
            }).catch((err) => console.error('Auto bulk QR export failed to queue:', err.message));
        });

    } catch (error) {
        console.error('Campaign Payment Error:', error);
        res.status(error.status || 500).json({ message: 'Payment failed', error: error.message });
    }
};

// Download QR PDF for an order
const { generateQrPdf } = require('../utils/qrPdfGenerator');

const isTruthyFlag = (value) => ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
const resolveRequestedQrsPerSheet = (value) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return null;
    return parsed;
};

const resolveCampaignProductName = async (campaign) => {
    if (!campaign) return null;

    if (campaign?.Product?.name) {
        return campaign.Product.name;
    }

    const allocations = Array.isArray(campaign?.allocations) ? campaign.allocations : [];
    const fallbackProductId = allocations.find((alloc) => alloc?.productId)?.productId;
    if (!fallbackProductId) return null;

    const fallbackProduct = await prisma.product.findUnique({
        where: { id: fallbackProductId },
        select: { name: true }
    });
    return fallbackProduct?.name || null;
};

exports.downloadOrderQrPdf = async (req, res) => {
    try {
        const { orderId } = req.params;
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) {
            return res.status(404).json({ message: 'Vendor profile not found' });
        }

        // Get order and verify ownership
        const order = await prisma.qROrder.findUnique({
            where: { id: orderId },
            include: {
                QRCodes: {
                    select: { uniqueHash: true, cashbackAmount: true }
                }
            }
        });

        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        if (order.vendorId !== vendor.id) {
            return res.status(403).json({ message: 'Unauthorized access to this order' });
        }

        if (order.status !== 'paid') {
            return res.status(400).json({ message: 'PDF is only available for paid orders' });
        }

        if (!order.QRCodes || order.QRCodes.length === 0) {
            return res.status(400).json({ message: 'No QR codes found for this order' });
        }

        // Get campaign title
        const campaign = await prisma.campaign.findUnique({
            where: { id: order.campaignId },
            select: {
                title: true,
                allocations: true,
                Product: { select: { name: true } },
                Brand: { select: { name: true, logoUrl: true } }
            }
        });
        const productName = await resolveCampaignProductName(campaign);

        // Generate PDF
        const pdfBuffer = await generateQrPdf({
            qrCodes: order.QRCodes,
            campaignTitle: campaign?.title || 'Campaign',
            orderId: order.id,
            brandName: campaign?.Brand?.name,
            brandLogoUrl: campaign?.Brand?.logoUrl,
            productName
        });

        // Send PDF
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="QR_Order_${orderId.slice(-8)}.pdf"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'qr_pdf_download',
            entityType: 'order',
            entityId: orderId,
            metadata: { qrCount: order.QRCodes.length },
            req
        });

        try {
            await createVendorNotification({
                vendorId: vendor.id,
                title: 'Order PDF downloaded',
                message: `Downloaded QR PDF for order #${order.id.slice(-6)} (${campaign?.title || 'Campaign'}).`,
                type: 'pdf-downloaded',
                metadata: {
                    tab: 'campaigns',
                    orderId: order.id,
                    campaignId: order.campaignId,
                    qrCount: order.QRCodes.length
                }
            });
        } catch (notificationError) {
            console.error('Order PDF notification error:', notificationError.message);
        }

    } catch (error) {
        console.error('PDF Download Error:', error);
        if (res.headersSent) return;
        res.status(500).json({ message: 'Failed to generate PDF', error: error.message });
    }
};

exports.downloadVendorInventoryQrPdf = async (req, res) => {
    try {
        const fastModeRequested = isTruthyFlag(req.query?.fast);
        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) {
            return res.status(404).json({ message: 'Vendor profile not found' });
        }

        const requestedSeries = normalizeSeriesCode(req.query?.seriesCode, null);
        if (isTruthyFlag(req.query?.background)) {
            const job = await queueInventoryExportJob({
                vendorId: vendor.id,
                seriesCode: requestedSeries,
                splitParts: !isTruthyFlag(req.query?.singleFile),
                requestedByUserId: req.user.id
            });
            return res.status(202).json({
                message: 'Background inventory export started',
                job
            });
        }

        const parsedLimit = Number.parseInt(req.query?.limit, 10);
        const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, 50000)
            : 5000;

        const where = {
            vendorId: vendor.id,
            status: 'inventory'
        };
        if (requestedSeries) {
            where.seriesCode = requestedSeries;
        }

        const qrCodes = await prisma.qRCode.findMany({
            where,
            orderBy: [
                { seriesCode: 'asc' },
                { seriesOrder: 'asc' },
                { createdAt: 'asc' }
            ],
            take: safeLimit,
            select: {
                uniqueHash: true,
                cashbackAmount: true
            }
        });

        if (!qrCodes.length) {
            return res.status(404).json({
                message: requestedSeries
                    ? `No inventory QR codes available for series "${requestedSeries}".`
                    : 'No inventory QR codes available for download.'
            });
        }

        const sheetLabel = requestedSeries
            ? `Prebuilt Inventory (${requestedSeries})`
            : 'Prebuilt Inventory (All Series)';

        const pdfBuffer = await generateQrPdf({
            qrCodes,
            campaignTitle: sheetLabel,
            orderId: `inventory-${vendor.id.slice(-6)}`,
            brandName: vendor.businessName || 'Vendor',
            compactMode: fastModeRequested
        });

        const fileSuffix = requestedSeries ? requestedSeries.replace(/[^a-z0-9_-]+/gi, '_') : 'all';
        const fileName = `QR_Inventory_${fileSuffix}_${Date.now()}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.send(pdfBuffer);

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'inventory_qr_pdf_download',
            entityType: 'qr',
            metadata: {
                seriesCode: requestedSeries,
                qrCount: qrCodes.length
            },
            req
        });
    } catch (error) {
        if (res.headersSent) return;
        res.status(500).json({ message: 'Failed to generate inventory PDF', error: error.message });
    }
};

exports.startVendorInventoryBulkQrExport = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const requestedSeries = normalizeSeriesCode(
            req.body?.seriesCode ?? req.query?.seriesCode,
            null
        );
        const singleFileRequested = isTruthyFlag(req.body?.singleFile ?? req.query?.singleFile);
        const job = await queueInventoryExportJob({
            vendorId: vendor.id,
            seriesCode: requestedSeries,
            splitParts: !singleFileRequested,
            requestedByUserId: req.user.id
        });

        res.status(202).json({
            message: 'Background inventory export started',
            job
        });
    } catch (error) {
        res.status(error.status || 500).json({
            message: error.message || 'Failed to start inventory export'
        });
    }
};

exports.startCampaignBulkQrExport = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const requestedQrsPerSheet = resolveRequestedQrsPerSheet(
            req.body?.qrsPerSheet ?? req.query?.qrsPerSheet
        );
        const singleFileRequested = isTruthyFlag(req.body?.singleFile ?? req.query?.singleFile);
        const job = await queueCampaignExportJob({
            vendorId: vendor.id,
            campaignId: req.params.id,
            qrsPerSheet: requestedQrsPerSheet,
            splitParts: !singleFileRequested,
            requestedByUserId: req.user.id
        });

        res.status(202).json({
            message: 'Background campaign export started',
            job
        });
    } catch (error) {
        res.status(error.status || 500).json({
            message: error.message || 'Failed to start campaign export'
        });
    }
};

exports.getVendorBulkQrExportJobs = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const jobs = await listVendorBulkExportJobs(vendor.id, req.query?.limit);

        res.json({
            jobs
        });
    } catch (error) {
        res.status(error.status || 500).json({
            message: error.message || 'Failed to fetch export jobs'
        });
    }
};

exports.getVendorBulkQrExportJob = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const job = await getVendorBulkExportJob(vendor.id, req.params.jobId);

        res.json({
            job
        });
    } catch (error) {
        res.status(error.status || 500).json({
            message: error.message || 'Failed to fetch export job'
        });
    }
};

exports.cancelVendorBulkExportJob = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const { jobId } = req.params;

        if (!prisma.bulkExportJob) {
            return res.status(500).json({ message: 'Export job tracking is currently initializing. Please try again later.' });
        }

        // Verify ownership and status
        const job = await prisma.bulkExportJob.findFirst({
            where: {
                id: jobId,
                vendorId: vendor.id,
                status: {
                    in: ['queued', 'processing']
                }
            }
        });

        if (!job) {
            return res.status(404).json({ message: 'Export job not found or cannot be cancelled.' });
        }

        // Cancel the job (mark as failed)
        await prisma.bulkExportJob.update({
            where: { id: jobId },
            data: {
                status: 'failed',
                errorMsg: 'Cancelled by user.'
            }
        });

        res.json({ message: 'Export job cancelled successfully.' });
    } catch (error) {
        if (error.code === 'P2021') {
            return res.json({ message: 'Export job cancelled.' }); // act like success if it does not exist
        }
        res.status(500).json({ message: 'Failed to cancel export job.', error: error.message });
    }
};

exports.deleteVendorBulkExportJob = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const { jobId } = req.params;

        if (!prisma.bulkExportJob) {
            return res.status(500).json({ message: 'Export job tracking is currently initializing. Please try again later.' });
        }

        const job = await prisma.bulkExportJob.findFirst({
            where: {
                id: jobId,
                vendorId: vendor.id
            }
        });

        if (!job) {
            return res.status(404).json({ message: 'Export job not found.' });
        }

        await prisma.bulkExportJob.delete({
            where: { id: jobId }
        });

        res.json({ message: 'Export job deleted successfully.' });
    } catch (error) {
        if (error.code === 'P2021') {
            return res.json({ message: 'Export job deleted.' });
        }
        res.status(500).json({ message: 'Failed to delete export job.', error: error.message });
    }
};

exports.downloadVendorBulkQrExportJob = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const artifact = await getVendorBulkExportArtifact(vendor.id, req.params.jobId);

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'bulk_qr_export_download',
            entityType: 'export_job',
            entityId: req.params.jobId,
            metadata: {
                fileName: artifact.fileName,
                fileMimeType: artifact.fileMimeType
            },
            req
        });

        res.setHeader('Content-Type', artifact.fileMimeType);
        return res.download(artifact.absolutePath, artifact.fileName);
    } catch (error) {
        if (res.headersSent) return;
        res.status(error.status || 500).json({
            message: error.message || 'Failed to download export file'
        });
    }
};

// Assign cashback amount to QRs by sheet (A=0-24, B=25-49, etc.) for postpaid campaigns
exports.assignSheetCashback = async (req, res) => {
    try {
        const { id: campaignId } = req.params;
        const { sheetIndex } = req.body || {};
        const requestedAmount =
            req.body?.cashbackAmount ??
            req.body?.newValue ??
            req.body?.new_value;

        const parsedSheet = Number.parseInt(sheetIndex, 10);
        const parsedAmount = toPositiveAmount(requestedAmount);

        if (!Number.isFinite(parsedSheet) || parsedSheet < 0) {
            return res.status(400).json({ message: 'Invalid sheet index' });
        }
        if (!parsedAmount) {
            return res.status(400).json({ message: 'Invalid cashback amount' });
        }

        const { vendor } = await ensureVendorAndWallet(req.user.id);

        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            include: { Brand: { select: { vendorId: true } } }
        });

        if (!campaign || campaign.Brand?.vendorId !== vendor.id) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        if (campaign.planType !== 'postpaid') {
            return res.status(400).json({ message: 'Sheet cashback assignment is only available for postpaid campaigns' });
        }

        const sheetLabel = toRomanSheetLabel(parsedSheet + 1);

        const result = await prisma.$transaction(async (tx) => {
            const qrWhere = {
                campaignId,
                status: { in: POSTPAID_SHEET_QR_STATUSES }
            };

            const totalQrsCount = await tx.qRCode.count({ where: qrWhere });
            if (!totalQrsCount) {
                const error = new Error('No QR codes found for this campaign');
                error.status = 400;
                throw error;
            }

            const qrsPerSheet = resolvePostpaidSheetSize(totalQrsCount);
            const start = parsedSheet * qrsPerSheet;
            const sheetQrs = await tx.qRCode.findMany({
                where: qrWhere,
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                skip: start,
                take: qrsPerSheet,
                select: {
                    id: true,
                    status: true,
                    cashbackAmount: true
                }
            });

            if (!sheetQrs.length) {
                const error = new Error('No QR codes found for this sheet');
                error.status = 400;
                throw error;
            }

            const sheetQrIds = sheetQrs.map((qr) => qr.id);
            const mutableQrIds = [];
            const previousMutableValues = [];

            sheetQrs.forEach((qr) => {
                if (POSTPAID_MUTABLE_QR_STATUS_SET.has(qr.status)) {
                    mutableQrIds.push(qr.id);
                    previousMutableValues.push(toNumber(qr.cashbackAmount, 0));
                }
            });

            let updatedQrCount = 0;
            if (mutableQrIds.length) {
                const updated = await tx.qRCode.updateMany({
                    where: {
                        id: { in: mutableQrIds },
                        status: { in: POSTPAID_MUTABLE_QR_STATUSES }
                    },
                    data: {
                        cashbackAmount: parsedAmount
                    }
                });
                updatedQrCount = Number(updated?.count || 0);
            }

            const unchangedRedeemedCount = await tx.qRCode.count({
                where: {
                    id: { in: sheetQrIds },
                    status: POSTPAID_REDEEMED_QR_STATUS
                }
            });

            const aggregate = await tx.qRCode.aggregate({
                where: { campaignId },
                _sum: { cashbackAmount: true }
            });
            const totalCashback = toNumber(aggregate?._sum?.cashbackAmount, 0);

            await tx.campaign.update({
                where: { id: campaignId },
                data: {
                    subtotal: totalCashback,
                    totalBudget: totalCashback
                }
            });

            const hasUniformPreviousValue =
                previousMutableValues.length > 0 &&
                previousMutableValues.every((value) => value === previousMutableValues[0]);

            return {
                qrsPerSheet,
                sheetQrCount: sheetQrIds.length,
                updatedQrCount,
                unchangedRedeemedCount,
                unchangedQrCount: Math.max(0, sheetQrIds.length - updatedQrCount),
                skippedDuringUpdate: Math.max(0, mutableQrIds.length - updatedQrCount),
                totalBudget: totalCashback,
                oldValue: hasUniformPreviousValue ? previousMutableValues[0] : null
            };
        }, {
            timeout: LARGE_TX_TIMEOUT_MS,
            maxWait: LARGE_TX_MAX_WAIT_MS
        });

        if (!result.updatedQrCount) {
            const message =
                result.unchangedRedeemedCount >= result.sheetQrCount
                    ? 'All QR codes in this set are already redeemed. No changes applied.'
                    : `No unused QR codes were eligible for update on Sheet ${sheetLabel}.`;

            return res.json({
                status: 'NO_CHANGES',
                message,
                updated_qr_count: 0,
                unchanged_redeemed_count: result.unchangedRedeemedCount,
                unchanged_qr_count: result.unchangedQrCount,
                skipped_during_update: result.skippedDuringUpdate,
                totalBudget: result.totalBudget,
                updated: 0,
                sheetLabel,
                qrsPerSheet: result.qrsPerSheet
            });
        }

        return res.json({
            status: 'SUCCESS',
            message: `Updated ${result.updatedQrCount} unused QR codes on Sheet ${sheetLabel} to Rs. ${parsedAmount}.`,
            old_value: result.oldValue,
            new_value: parsedAmount,
            updated_qr_count: result.updatedQrCount,
            unchanged_redeemed_count: result.unchangedRedeemedCount,
            unchanged_qr_count: result.unchangedQrCount,
            skipped_during_update: result.skippedDuringUpdate,
            totalBudget: result.totalBudget,
            updated: result.updatedQrCount,
            sheetLabel,
            qrsPerSheet: result.qrsPerSheet
        });
    } catch (error) {
        console.error('Assign Sheet Cashback Error:', error);
        res.status(error.status || 500).json({ message: error.message || 'Failed to assign cashback' });
    }
};

// Pay for a specific sheet's cashback (Postpaid)
exports.paySheetCashback = async (req, res) => {
    try {
        const { id: campaignId } = req.params;
        const { sheetIndex, cashbackAmount } = req.body;

        const parsedSheet = Number.parseInt(sheetIndex, 10);
        const parsedAmount = Number.parseFloat(cashbackAmount);

        if (!Number.isFinite(parsedSheet) || parsedSheet < 0) {
            return res.status(400).json({ message: 'Invalid sheet index' });
        }
        if (!Number.isFinite(parsedAmount) || parsedAmount < 0) {
            return res.status(400).json({ message: 'Invalid cashback amount' });
        }

        const vendor = await requireVendorProfile(prisma, req.user.id);
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            include: { Brand: true }
        });

        if (!campaign || campaign.Brand?.vendorId !== vendor.id) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        if (campaign.planType !== 'postpaid') {
            return res.status(400).json({ message: 'Sheet payment is only for postpaid campaigns' });
        }

        const allQrsCount = await prisma.qRCode.count({
            where: { campaignId, status: { in: POSTPAID_SHEET_QR_STATUSES } }
        });
        const qrsPerSheet = resolvePostpaidSheetSize(allQrsCount);
        const start = parsedSheet * qrsPerSheet;
        const sheetQrs = await prisma.qRCode.findMany({
            where: {
                campaignId,
                status: { in: POSTPAID_SHEET_QR_STATUSES }
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            skip: start,
            take: qrsPerSheet,
            select: { id: true, status: true }
        });
        const sheetQrCount = sheetQrs.length;

        if (sheetQrCount <= 0) {
            return res.status(400).json({ message: 'No QR codes found for this sheet' });
        }

        const redeemableQrCount = sheetQrs.filter((qr) => POSTPAID_MUTABLE_QR_STATUS_SET.has(qr.status)).length;
        const redeemedQrCount = sheetQrs.filter((qr) => qr.status === POSTPAID_REDEEMED_QR_STATUS).length;

        const aggregate = await prisma.qRCode.aggregate({
            where: { campaignId },
            _sum: { cashbackAmount: true }
        });
        const campaignTotalBudget = Number(aggregate?._sum?.cashbackAmount || 0);

        return res.json({
            message: 'No upfront payment required. Sheet cashback is saved and vendor wallet will be charged only on QR redemption.',
            totalPaid: 0,
            sheetQrCount,
            redeemableQrCount,
            redeemedQrCount,
            techFeeTotal: 0,
            voucherFeeTotal: 0,
            cashbackTotal: 0,
            qrsPerSheet,
            campaignTotalBudget,
            campaignTitle: campaign.title,
            invoice: null,
            invoiceId: null
        });

    } catch (error) {
        console.error('Pay Sheet Cashback Error:', error);
        res.status(error.status || 500).json({ message: error.message || 'Failed to pay for sheet' });
    }
};


// Update batches for a postpaid campaign (Rewrite cashback amounts for specific QR ranges)
exports.updatePostpaidCampaignBatches = async (req, res) => {
    try {
        const { id: campaignId } = req.params;
        const batches = Array.isArray(req.body) ? req.body : req.body?.batches;

        if (!Array.isArray(batches)) {
            return res.status(400).json({ message: 'Invalid batches payload' });
        }

        const vendor = await requireVendorProfile(prisma, req.user.id);
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            include: { Brand: true }
        });

        if (!campaign || campaign.Brand?.vendorId !== vendor.id) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        if (campaign.planType !== 'postpaid') {
            return res.status(400).json({ message: 'Batch update is only for postpaid campaigns' });
        }

        const result = await prisma.$transaction(async (tx) => {
            const qrWhere = {
                campaignId,
                status: { in: POSTPAID_SHEET_QR_STATUSES }
            };

            const allQrs = await tx.qRCode.findMany({
                where: qrWhere,
                orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
                select: { id: true, status: true, cashbackAmount: true }
            });

            if (!allQrs.length) {
                const error = new Error('No QR codes found for this campaign');
                error.status = 400;
                throw error;
            }

            let cursor = 0;
            let totalUpdatedCount = 0;

            for (const batch of batches) {
                const qty = Number(batch.quantity);
                const amount = Number(batch.cashbackAmount);
                
                if (qty <= 0) continue;

                // Take the segment of QRs corresponding to this batch
                const batchQrs = allQrs.slice(cursor, cursor + qty);
                const mutableIds = batchQrs
                    .filter(qr => POSTPAID_MUTABLE_QR_STATUS_SET.has(qr.status))
                    .map(qr => qr.id);

                if (mutableIds.length > 0) {
                    const updateResult = await tx.qRCode.updateMany({
                        where: { id: { in: mutableIds } },
                        data: { cashbackAmount: amount }
                    });
                    totalUpdatedCount += Number(updateResult?.count || 0);
                }
                cursor += qty;
            }

            // Recalculate campaign budget
            const aggregate = await tx.qRCode.aggregate({
                where: { campaignId },
                _sum: { cashbackAmount: true }
            });
            const totalCashback = Number(aggregate?._sum?.cashbackAmount || 0);

            await tx.campaign.update({
                where: { id: campaignId },
                data: {
                    allocations: batches,
                    subtotal: totalCashback,
                    totalBudget: totalCashback
                }
            });

            return {
                totalUpdatedCount,
                totalBudget: totalCashback
            };
        }, {
            timeout: LARGE_TX_TIMEOUT_MS,
            maxWait: LARGE_TX_MAX_WAIT_MS
        });

        res.json({
            message: `Successfully updated ${result.totalUpdatedCount} QR codes across batches.`,
            totalBudget: result.totalBudget
        });
    } catch (error) {
        console.error('Update Postpaid Batches Error:', error);
        res.status(error.status || 500).json({ message: error.message || 'Failed to update batches' });
    }
};

// Download QR PDF for a campaign (already funded/redeemed QRs only)
exports.downloadCampaignQrPdf = async (req, res) => {
    try {
        const requestStartedAt = Date.now();
        const marks = {};
        const mark = (key) => {
            marks[key] = Date.now();
        };
        const { id: campaignId } = req.params;
        const explicitFastModeRequested = isTruthyFlag(req.query?.fast);
        const skipLogoRequested = isTruthyFlag(req.query?.skipLogo);
        const requestedQrsPerSheet = resolveRequestedQrsPerSheet(req.query?.qrsPerSheet);
        const parsedSheetIndex = Number.parseInt(req.query?.sheetIndex, 10);
        const parsedOffset = Number.parseInt(req.query?.offset, 10);
        const parsedLimit = Number.parseInt(req.query?.limit, 10);
        const parsedChunkPart = Number.parseInt(req.query?.part, 10);
        const parsedChunkTotalParts = Number.parseInt(req.query?.totalParts, 10);
        const safeOffset = Number.isFinite(parsedOffset) && parsedOffset >= 0 ? parsedOffset : 0;
        const safeLimit = Number.isFinite(parsedLimit) && parsedLimit > 0
            ? Math.min(parsedLimit, CAMPAIGN_QR_DOWNLOAD_CHUNK_MAX)
            : 800;
        const hasRequestedSheet =
            Number.isFinite(parsedSheetIndex) && parsedSheetIndex >= 0;
        const sheetLabelFor = (index) => toRomanSheetLabel(index + 1);

        const vendor = await prisma.vendor.findUnique({ where: { userId: req.user.id } });
        if (!vendor) {
            return res.status(404).json({ message: 'Vendor profile not found' });
        }
        mark('vendorLookup');

        // Get campaign and verify ownership
        const campaign = await prisma.campaign.findUnique({
            where: { id: campaignId },
            include: {
                Product: { select: { name: true } },
                Brand: { select: { vendorId: true, name: true, logoUrl: true } }
            }
        });

        if (!campaign) {
            return res.status(404).json({ message: 'Campaign not found' });
        }

        if (campaign.Brand.vendorId !== vendor.id) {
            return res.status(403).json({ message: 'Unauthorized access to this campaign' });
        }

        if (isTruthyFlag(req.query?.background)) {
            const job = await queueCampaignExportJob({
                vendorId: vendor.id,
                campaignId,
                qrsPerSheet: requestedQrsPerSheet,
                splitParts: !isTruthyFlag(req.query?.singleFile),
                requestedByUserId: req.user.id
            });
            return res.status(202).json({
                message: 'Background campaign export started',
                job
            });
        }

        if (campaign.status !== 'active') {
            return res.status(400).json({ message: 'PDF is only available for active campaigns' });
        }
        mark('campaignLookup');

        const qrWhere = {
            campaignId,
            status: {
                in: POSTPAID_SHEET_QR_STATUSES
            }
        };

        const isSheetScopedPostpaid =
            campaign.planType === 'postpaid' && hasRequestedSheet;
        const hasChunkedWindow =
            !isSheetScopedPostpaid &&
            (
                (Number.isFinite(parsedOffset) && parsedOffset >= 0) ||
                (Number.isFinite(parsedLimit) && parsedLimit > 0)
            );
        const fastModeRequested =
            explicitFastModeRequested || isSheetScopedPostpaid || hasChunkedWindow;
        const totalCampaignQrCount =
            campaign.planType === 'postpaid'
                ? await prisma.qRCode.count({ where: qrWhere })
                : null;
        const effectiveQrCount = Number.isFinite(totalCampaignQrCount)
            ? totalCampaignQrCount
            : await prisma.qRCode.count({ where: qrWhere });
        if (
            !isSheetScopedPostpaid &&
            !hasChunkedWindow &&
            effectiveQrCount > CAMPAIGN_QR_FULL_DOWNLOAD_LIMIT
        ) {
            const recommendedChunkSize = CAMPAIGN_QR_DOWNLOAD_CHUNK_MAX;
            const recommendedTotalParts = Math.max(
                1,
                Math.ceil(effectiveQrCount / recommendedChunkSize)
            );
            return res.status(413).json({
                message: `Campaign has ${effectiveQrCount} QR codes. Use chunked download to avoid timeouts.`,
                code: 'CAMPAIGN_PDF_TOO_LARGE',
                totalQrs: effectiveQrCount,
                recommendedChunkSize,
                recommendedTotalParts
            });
        }
        const qrsPerSheet =
            campaign.planType === 'postpaid'
                ? resolvePostpaidSheetSize(totalCampaignQrCount, requestedQrsPerSheet)
                : 25;

        if (
            isSheetScopedPostpaid &&
            Number.isFinite(totalCampaignQrCount) &&
            parsedSheetIndex * qrsPerSheet >= totalCampaignQrCount
        ) {
            return res.status(400).json({ message: 'Invalid sheet selected for download' });
        }

        const qrCodes = await prisma.qRCode.findMany({
            where: qrWhere,
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            ...(isSheetScopedPostpaid
                ? {
                    skip: parsedSheetIndex * qrsPerSheet,
                    take: qrsPerSheet
                }
                : hasChunkedWindow
                    ? {
                        skip: safeOffset,
                        take: safeLimit
                    }
                    : {}),
            select: {
                uniqueHash: true,
                cashbackAmount: true,
                status: true
            }
        });
        mark('qrFetch');

        if (!qrCodes.length) {
            return res.status(400).json({
                message: isSheetScopedPostpaid
                    ? `No QR codes found for Sheet ${sheetLabelFor(parsedSheetIndex)}.`
                    : hasChunkedWindow
                        ? 'No QR codes found for this download chunk.'
                        : 'No funded QRs found for this campaign. Recharge inventory first, then download.'
            });
        }
        const normalizedQrCodes = Array.isArray(qrCodes) ? qrCodes.map((item) => ({ ...item })) : [];

        // Postpaid PDFs now show assigned QR cashback directly.
        const productName = fastModeRequested
            ? campaign?.Product?.name || null
            : await resolveCampaignProductName(campaign);
        const isCompactDownload =
            fastModeRequested ||
            (campaign.planType === 'postpaid' &&
                normalizedQrCodes.every((qr) => toNumber(qr?.cashbackAmount, 0) <= 0));
        const totalSheetCountForPdf =
            campaign.planType === 'postpaid'
                ? Number.isFinite(totalCampaignQrCount)
                    ? Math.max(1, Math.ceil(totalCampaignQrCount / qrsPerSheet))
                    : undefined
                : undefined;
        const downloadSheetLabel =
            isSheetScopedPostpaid ? sheetLabelFor(parsedSheetIndex) : null;
        const shouldSkipBrandLogo = skipLogoRequested || (campaign.planType === 'postpaid' && fastModeRequested);
        const chunkPartNumber = hasChunkedWindow
            ? (Number.isFinite(parsedChunkPart) && parsedChunkPart > 0
                ? parsedChunkPart
                : Math.floor(safeOffset / safeLimit) + 1)
            : null;
        const chunkTotalParts = hasChunkedWindow && Number.isFinite(parsedChunkTotalParts) && parsedChunkTotalParts > 0
            ? parsedChunkTotalParts
            : null;

        const pdfBuffer = await generateQrPdf({
            qrCodes: normalizedQrCodes,
            campaignTitle: campaign.title,
            orderId: campaignId,
            brandName: campaign.Brand.name,
            brandLogoUrl: shouldSkipBrandLogo ? null : campaign.Brand.logoUrl,
            planType: campaign.planType,
            productName,
            compactMode: isCompactDownload,
            startSheetIndex: isSheetScopedPostpaid
                ? parsedSheetIndex
                : (campaign.planType === 'postpaid' && hasChunkedWindow
                    ? Math.floor(safeOffset / qrsPerSheet)
                    : 0),
            totalSheetCount: totalSheetCountForPdf,
            qrsPerSheet
        });
        mark('pdfReady');

        const fileName = isSheetScopedPostpaid
            ? `QR_Campaign_${campaignId.slice(-8)}_Sheet_${downloadSheetLabel}_${Date.now()}.pdf`
            : hasChunkedWindow
                ? chunkTotalParts
                    ? `QR_Campaign_${campaignId.slice(-8)}_Part_${chunkPartNumber}_of_${chunkTotalParts}_${Date.now()}.pdf`
                    : `QR_Campaign_${campaignId.slice(-8)}_Part_${chunkPartNumber}_${Date.now()}.pdf`
                : `QR_Campaign_${campaignId.slice(-8)}_${Date.now()}.pdf`;
        const setupMs = Math.max(0, (marks.campaignLookup || Date.now()) - requestStartedAt);
        const dbMs = Math.max(0, (marks.qrFetch || Date.now()) - (marks.campaignLookup || requestStartedAt));
        const pdfMs = Math.max(0, (marks.pdfReady || Date.now()) - (marks.qrFetch || requestStartedAt));
        const totalMs = Date.now() - requestStartedAt;

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        res.setHeader('X-PDF-Fast-Mode', fastModeRequested ? '1' : '0');
        res.setHeader('X-PDF-Skip-Logo', shouldSkipBrandLogo ? '1' : '0');
        res.setHeader('X-PDF-QR-Count', String(normalizedQrCodes.length));
        res.setHeader('X-PDF-QRS-PER-SHEET', String(qrsPerSheet));
        res.setHeader('X-PDF-Chunked', hasChunkedWindow ? '1' : '0');
        res.setHeader('X-PDF-Chunk-Offset', String(hasChunkedWindow ? safeOffset : 0));
        res.setHeader('X-PDF-Chunk-Limit', String(hasChunkedWindow ? safeLimit : normalizedQrCodes.length));
        res.setHeader('X-PDF-Chunk-Part', String(hasChunkedWindow ? chunkPartNumber : 1));
        res.setHeader('X-PDF-Chunk-Total-Parts', String(hasChunkedWindow && chunkTotalParts ? chunkTotalParts : 1));
        res.setHeader('X-PDF-Total-Ms', String(totalMs));
        res.setHeader(
            'Server-Timing',
            `setup;dur=${setupMs},db;dur=${dbMs},pdf;dur=${pdfMs},total;dur=${totalMs}`
        );
        res.send(pdfBuffer);

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'campaign_qr_pdf_download',
            entityType: 'campaign',
            entityId: campaignId,
            metadata: {
                qrCount: normalizedQrCodes.length,
                qrsPerSheet,
                sheetIndex: isSheetScopedPostpaid ? parsedSheetIndex : null,
                chunked: hasChunkedWindow,
                chunkOffset: hasChunkedWindow ? safeOffset : null,
                chunkLimit: hasChunkedWindow ? safeLimit : null,
                chunkPart: hasChunkedWindow ? chunkPartNumber : null,
                chunkTotalParts: hasChunkedWindow ? chunkTotalParts : null
            },
            req
        });

        const shouldNotifyDownload =
            !hasChunkedWindow ||
            (chunkPartNumber !== null && chunkTotalParts !== null && chunkPartNumber >= chunkTotalParts);
        try {
            if (shouldNotifyDownload) {
                await createVendorNotification({
                    vendorId: vendor.id,
                    title: 'Campaign PDF downloaded',
                    message: isSheetScopedPostpaid
                        ? `Downloaded Sheet ${downloadSheetLabel} QR PDF for campaign "${campaign.title}".`
                        : hasChunkedWindow && chunkTotalParts
                            ? `Downloaded ${chunkTotalParts} chunked QR PDFs for campaign "${campaign.title}".`
                            : `Downloaded QR PDF for campaign "${campaign.title}".`,
                    type: 'pdf-downloaded',
                    metadata: {
                        tab: 'campaigns',
                        campaignId,
                        qrCount: normalizedQrCodes.length,
                        qrsPerSheet,
                        sheetIndex: isSheetScopedPostpaid ? parsedSheetIndex : null,
                        chunked: hasChunkedWindow,
                        chunkPart: hasChunkedWindow ? chunkPartNumber : null,
                        chunkTotalParts: hasChunkedWindow ? chunkTotalParts : null
                    }
                });
            }
        } catch (notificationError) {
            console.error('Campaign PDF notification error:', notificationError.message);
        }

    } catch (error) {
        if (res.headersSent) return;
        res.status(500).json({ message: 'Failed to generate PDF', error: error.message });
    }
};

// Helper: Mask phone number (e.g., 9876543210 -> 98****3210)
const maskPhone = (phone) => {
    if (!phone || phone.length < 6) return '****';
    return phone.slice(0, 2) + '****' + phone.slice(-4);
};

// Helper: Mask name (e.g., John Doe -> J***e)
const maskName = (name) => {
    if (!name || name.length < 2) return '****';
    return name[0] + '***' + name.slice(-1);
};

// B11: Get Vendor Redemptions
exports.getVendorRedemptions = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const { page, limit, skip } = parsePagination(req);
        const where = buildRedemptionEventWhere(vendor, req.query);
        where.type = req.query.type || 'redeem_success';

        const mobileNeedle = String(req.query.mobile || '').trim();
        if (mobileNeedle) {
            where.User = {
                is: {
                    phoneNumber: {
                        contains: mobileNeedle
                    }
                }
            };
        }

        let [events, total] = await Promise.all([
            prisma.redemptionEvent.findMany({
                where,
                skip,
                take: limit,
                include: {
                    QRCode: {
                        select: { id: true, uniqueHash: true, campaignBudgetId: true }
                    },
                    Campaign: {
                        select: { id: true, title: true }
                    },
                    User: {
                        select: { id: true, name: true, phoneNumber: true }
                    }
                },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.redemptionEvent.count({ where })
        ]);
        let redemptions = [];

        if (total === 0 && where.type === 'redeem_success') {
            const legacyWhere = buildLegacyQrRedemptionWhere(vendor, req.query);
            const [legacyQrs, legacyTotal] = await Promise.all([
                prisma.qRCode.findMany({
                    where: legacyWhere,
                    skip,
                    take: limit,
                    select: {
                        id: true,
                        uniqueHash: true,
                        campaignBudgetId: true,
                        cashbackAmount: true,
                        redeemedAt: true,
                        redeemedByUserId: true,
                        Campaign: {
                            select: {
                                id: true,
                                title: true
                            }
                        }
                    },
                    orderBy: { redeemedAt: 'desc' }
                }),
                prisma.qRCode.count({ where: legacyWhere })
            ]);

            const userIds = [...new Set(
                legacyQrs
                    .map((qr) => qr.redeemedByUserId)
                    .filter(Boolean)
            )];
            const users = userIds.length
                ? await prisma.user.findMany({
                    where: { id: { in: userIds } },
                    select: { id: true, name: true, phoneNumber: true }
                })
                : [];
            const userMap = new Map(users.map((user) => [user.id, user]));
            const mobileNeedle = String(req.query.mobile || '').trim();

            const legacyRedemptions = legacyQrs
                .map((qr) => mapLegacyQrRedemption(qr, userMap.get(qr.redeemedByUserId)))
                .filter((redemption) => {
                    if (!mobileNeedle) return true;
                    return String(redemption?.customer?.phone || '').includes(mobileNeedle);
                });

            redemptions = legacyRedemptions;
            total = mobileNeedle ? legacyRedemptions.length : legacyTotal;
        } else {
            redemptions = events.map(mapRedemptionEvent);
        }

        res.json({
            redemptions,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'view_redemptions',
            entityType: 'redemption',
            metadata: { page, limit, total },
            req
        });

    } catch (error) {
        console.error('[VendorRedemptions] Error:', error);
        res.status(500).json({ message: 'Failed to fetch redemptions', error: error.message });
    }
};

// B13: Create Vendor Support Ticket
exports.createVendorSupportTicket = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const { subject, message, priority = 'medium' } = req.body;

        if (!subject || !message) {
            return res.status(400).json({ message: 'Subject and message are required' });
        }

        const ticket = await prisma.supportTicket.create({
            data: {
                userId: req.user.id,
                subject,
                message,
                status: 'open'
            }
        });

        // Notify admins
        const admins = await prisma.user.findMany({
            where: { role: 'admin' },
            select: { id: true }
        });

        if (admins.length) {
            const notifications = admins.map(admin => ({
                userId: admin.id,
                title: 'New Support Ticket',
                message: `Vendor "${vendor.businessName}" created a support ticket: ${subject}`,
                type: 'support_ticket',
                metadata: {
                    ticketId: ticket.id,
                    vendorId: vendor.id,
                    priority
                }
            }));
            await prisma.notification.createMany({ data: notifications });
        }

        res.status(201).json({
            success: true,
            message: 'Support ticket created',
            ticket
        });

        safeLogVendorActivity({
            vendorId: vendor.id,
            action: 'create_support_ticket',
            entityType: 'support_ticket',
            entityId: ticket.id,
            metadata: { subject, priority },
            req
        });

    } catch (error) {
        console.error('[VendorSupportTicket] Create Error:', error);
        res.status(500).json({ message: 'Failed to create support ticket', error: error.message });
    }
};

// B13: Get Vendor Support Tickets
exports.getVendorSupportTickets = async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req);
        const { status } = req.query;

        const whereClause = { userId: req.user.id };
        if (status) whereClause.status = status;

        const [tickets, total] = await Promise.all([
            prisma.supportTicket.findMany({
                where: whereClause,
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' }
            }),
            prisma.supportTicket.count({ where: whereClause })
        ]);

        res.json({
            tickets,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });

    } catch (error) {
        console.error('[VendorSupportTicket] Fetch Error:', error);
        res.status(500).json({ message: 'Failed to fetch support tickets', error: error.message });
    }
};

const escapeCsvValue = (value) => {
    const source = value === undefined || value === null ? '' : String(value);
    const escaped = source.replace(/"/g, '""');
    return `"${escaped}"`;
};

const buildVendorRedemptionOwnershipWhere = (vendor) => ({
    OR: [
        { vendorId: vendor.id },
        {
            Campaign: {
                is: {
                    Brand: { vendorId: vendor.id }
                }
            }
        },
        {
            QRCode: {
                is: {
                    vendorId: vendor.id
                }
            }
        }
    ]
});

const buildVendorQrOwnershipWhere = (vendor) => ({
    OR: [
        { vendorId: vendor.id },
        {
            Campaign: {
                is: {
                    Brand: { vendorId: vendor.id }
                }
            }
        }
    ]
});

const buildRedemptionEventWhere = (vendor, query = {}) => {
    const where = buildVendorRedemptionOwnershipWhere(vendor);

    const dateRange = buildDateRange(query);
    if (dateRange) where.createdAt = dateRange;

    if (query.campaignId) where.campaignId = query.campaignId;
    if (query.type) where.type = query.type;
    if (query.city) where.city = { equals: query.city, mode: 'insensitive' };
    if (query.state) where.state = { equals: query.state, mode: 'insensitive' };
    if (query.productId) {
        where.Campaign = {
            is: {
                productId: query.productId
            }
        };
    }
    if (query.batchId) {
        where.QRCode = {
            is: {
                campaignBudgetId: query.batchId
            }
        };
    }
    if (query.ownerScan === 'true') {
        where.userId = vendor.userId;
    }
    if (query.nonOwnerScan === 'true') {
        where.OR = [
            { userId: { not: vendor.userId } },
            { userId: null }
        ];
    }
    if (query.userId) {
        where.userId = query.userId;
    }

    return where;
};

const buildLegacyQrRedemptionWhere = (vendor, query = {}) => {
    const where = {
        ...buildVendorQrOwnershipWhere(vendor),
        status: 'redeemed'
    };

    const dateRange = buildDateRange(query);
    if (dateRange) where.redeemedAt = dateRange;

    if (query.campaignId) where.campaignId = query.campaignId;
    if (query.batchId) where.campaignBudgetId = query.batchId;
    if (query.userId) where.redeemedByUserId = query.userId;
    if (query.ownerScan === 'true') where.redeemedByUserId = vendor.userId;
    if (query.nonOwnerScan === 'true') {
        where.OR = [
            { redeemedByUserId: { not: vendor.userId } },
            { redeemedByUserId: null }
        ];
    }
    if (query.productId) {
        where.Campaign = {
            is: {
                productId: query.productId
            }
        };
    }

    return where;
};

const mapRedemptionEvent = (event) => {
    const userName = event?.User?.name || '';
    const maskedName = userName
        ? `${userName.charAt(0)}***${userName.charAt(userName.length - 1)}`
        : '****';
    const phone = event?.User?.phoneNumber || '';
    const maskedPhone = phone.length > 5 ? `${phone.slice(0, 2)}****${phone.slice(-4)}` : '****';

    return {
        id: event.id,
        createdAt: event.createdAt,
        amount: toNumber(event.amount, 0),
        type: event.type,
        city: event.city || null,
        state: event.state || null,
        pincode: event.pincode || null,
        lat: event.lat === null || event.lat === undefined ? null : Number(event.lat),
        lng: event.lng === null || event.lng === undefined ? null : Number(event.lng),
        accuracyMeters:
            event.accuracyMeters === null || event.accuracyMeters === undefined
                ? null
                : Number(event.accuracyMeters),
        qr: event.QRCode
            ? {
                id: event.QRCode.id,
                hash: event.QRCode.uniqueHash,
                campaignBudgetId: event.QRCode.campaignBudgetId || null
            }
            : null,
        campaign: event.Campaign
            ? {
                id: event.Campaign.id,
                title: event.Campaign.title
            }
            : null,
        customer: {
            id: event.userId || null,
            name: userName,
            phone: phone
        }
    };
};

const mapLegacyQrRedemption = (qr, user) => {
    const userName = user?.name || '';
    const phone = user?.phoneNumber || '';

    return {
        id: `legacy-${qr.id}`,
        createdAt: qr.redeemedAt || null,
        amount: toNumber(qr.cashbackAmount, 0),
        type: 'redeem_success',
        city: null,
        state: null,
        pincode: null,
        lat: null,
        lng: null,
        accuracyMeters: null,
        qr: {
            id: qr.id,
            hash: qr.uniqueHash,
            campaignBudgetId: qr.campaignBudgetId || null
        },
        campaign: qr.Campaign
            ? {
                id: qr.Campaign.id,
                title: qr.Campaign.title
            }
            : null,
        customer: {
            id: qr.redeemedByUserId || null,
            name: userName,
            phone
        }
    };
};

exports.exportVendorRedemptions = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);

        const qrWhere = buildLegacyQrRedemptionWhere(vendor, req.query);

        const qrs = await prisma.qRCode.findMany({
            where: qrWhere,
            include: {
                Campaign: { select: { title: true, Brand: { select: { vendorId: true } } } }
            },
            orderBy: { redeemedAt: 'desc' },
            take: 10000
        });

        const userIds = Array.from(new Set(qrs.map(qr => qr.redeemedByUserId).filter(Boolean)));
        let userMap = new Map();

        if (userIds.length > 0) {
            const users = await prisma.user.findMany({
                where: { id: { in: userIds } },
                select: { id: true, name: true, phoneNumber: true }
            });
            userMap = new Map(users.map(u => [u.id, u]));
        }

        const header = [
            'Redeemed Date',
            'Amount',
            'Campaign',
            'QR Hash',
            'Customer Name',
            'Customer Mobile'
        ];

        const rows = qrs.map((qr) => {
            const user = qr.redeemedByUserId ? userMap.get(qr.redeemedByUserId) : null;
            return [
                qr.redeemedAt ? new Date(qr.redeemedAt).toISOString() : new Date(qr.createdAt).toISOString(),
                toNumber(qr.cashbackAmount, 0).toFixed(2),
                qr.Campaign?.title || '',
                qr.uniqueHash || '',
                user?.name || '',
                user?.phoneNumber || ''
            ];
        });

        const escapeCsvValue = (value) => {
            const source = value === undefined || value === null ? '' : String(value);
            const escaped = source.replace(/"/g, '""');
            return `"${escaped}"`;
        };

        const csv = [header, ...rows]
            .map((row) => row.map(escapeCsvValue).join(','))
            .join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=\"vendor-redemptions-${Date.now()}.csv\"`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ message: 'Failed to export redemptions', error: error.message });
    }
};

exports.getVendorRedemptionsMap = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const where = buildRedemptionEventWhere(vendor, req.query);
        where.type = req.query.type || 'redeem_success';
        where.lat = { not: null };
        where.lng = { not: null };

        const events = await prisma.redemptionEvent.findMany({
            where,
            select: {
                id: true,
                lat: true,
                lng: true,
                city: true,
                state: true,
                amount: true,
                createdAt: true
            },
            orderBy: { createdAt: 'desc' },
            take: 20000
        });

        const pointsMap = new Map();
        events.forEach((event) => {
            const lat = Number(event.lat);
            const lng = Number(event.lng);
            if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;

            const key = `${lat.toFixed(4)}:${lng.toFixed(4)}`;
            const current = pointsMap.get(key) || {
                lat: Number(lat.toFixed(4)),
                lng: Number(lng.toFixed(4)),
                count: 0,
                totalAmount: 0,
                city: event.city || null,
                state: event.state || null,
                latestAt: event.createdAt
            };
            current.count += 1;
            current.totalAmount = toNumber(current.totalAmount + Number(event.amount || 0), 0);
            if (new Date(event.createdAt) > new Date(current.latestAt)) {
                current.latestAt = event.createdAt;
            }
            pointsMap.set(key, current);
        });

        res.json({
            totalPoints: pointsMap.size,
            totalEvents: events.length,
            points: Array.from(pointsMap.values())
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch map data', error: error.message });
    }
};

exports.getVendorSummaryAnalytics = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const where = buildRedemptionEventWhere(vendor, req.query);
        where.type = 'redeem_success';

        const events = await prisma.redemptionEvent.findMany({
            where,
            select: {
                id: true,
                userId: true,
                city: true,
                amount: true,
                createdAt: true
            },
            orderBy: { createdAt: 'asc' },
            take: 50000
        });

        const totalScans = events.length;
        const userCountMap = new Map();
        const cityCountMap = new Map();

        events.forEach((event) => {
            if (event.userId) {
                userCountMap.set(event.userId, (userCountMap.get(event.userId) || 0) + 1);
            }
            const cityKey = event.city ? event.city.trim() : 'Unknown';
            cityCountMap.set(cityKey, (cityCountMap.get(cityKey) || 0) + 1);
        });

        const uniqueUsers = userCountMap.size;
        const repeatedUsers = Array.from(userCountMap.values()).filter((count) => count > 1).length;

        let topCity = null;
        let topCityCount = 0;
        cityCountMap.forEach((count, city) => {
            if (count > topCityCount) {
                topCity = city;
                topCityCount = count;
            }
        });

        const trendMap = new Map();
        events.forEach((event) => {
            const d = new Date(event.createdAt);
            if (isNaN(d.getTime())) return;
            const dateStr = d.toISOString().slice(0, 10);
            trendMap.set(dateStr, (trendMap.get(dateStr) || 0) + 1);
        });

        const trend = Array.from(trendMap.entries())
            .sort((a, b) => (a[0] < b[0] ? -1 : 1))
            .map(([date, count]) => ({ date, count }));

        res.json({
            summary: {
                totalScans,
                uniqueUsers,
                repeatedUsers,
                topCity,
                topCityCount
            },
            trend
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch summary analytics', error: error.message });
    }
};

exports.getVendorCustomers = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const { page, limit } = parsePagination(req, { defaultLimit: 25, maxLimit: 200 });

        // Strip location from DB query — we filter on firstScanLocation post-processing instead.
        const { location: filterLocation, ...dbQueryParams } = req.query;
        const where = buildRedemptionEventWhere(vendor, dbQueryParams);
        where.type = 'redeem_success';
        where.userId = { not: null };

        const events = await prisma.redemptionEvent.findMany({
            where,
            include: {
                User: { select: { id: true, name: true, phoneNumber: true } }
            },
            orderBy: { createdAt: 'asc' },
            take: 100000
        });

        const customerMap = new Map();
        // Track first lat/lng per customer for reverse geocoding
        const customerCoords = new Map();

        events.forEach((event) => {
            const userId = event.userId;
            if (!userId) return;
            const existing = customerMap.get(userId);
            const amount = Number(event.amount || 0);
            const locationParts = [event.city, event.state, event.pincode].filter(Boolean);
            const locationStr = locationParts.length > 0 ? locationParts.join(', ') : '';

            if (!existing) {
                customerMap.set(userId, {
                    userId,
                    name: event.User?.name || 'Unknown',
                    mobile: event.User?.phoneNumber || null,
                    codeCount: 1,
                    rewardsEarned: amount,
                    firstScanLocation: locationStr || '-',
                    memberSince: event.createdAt,
                    lastScanned: event.createdAt
                });
                // Store coords for geocoding if location is missing or simple
                const isSimple = !locationStr || !locationStr.includes(',') || locationStr.split(',').length < 2;
                if (isSimple) {
                    const lat = Number(event.lat);
                    const lng = Number(event.lng);
                    if (Number.isFinite(lat) && Number.isFinite(lng)) {
                        customerCoords.set(userId, { lat, lng, eventId: event.id });
                    }
                }
                return;
            }
            existing.codeCount += 1;
            existing.rewardsEarned = toNumber(existing.rewardsEarned + amount, 0);
            existing.lastScanned = event.createdAt;
        });

        let customers = Array.from(customerMap.values()).map((entry) => ({
            ...entry,
            rewardsEarned: toNumber(entry.rewardsEarned, 0)
        }));

        // Reverse geocode customers if location is missing or too simple (e.g., just city)
        const needsGeocode = customers.filter((c) => {
            if (!customerCoords.has(c.userId)) return false;
            // Geocode if missing ('-') or very short (like only city name)
            const loc = c.firstScanLocation || '';
            return loc === '-' || !loc.includes(',') || loc.split(',').length < 2;
        });

        if (needsGeocode.length > 0) {
            // Deduplicate coordinates (round to 3 decimals)
            const uniqueCoords = new Map();
            needsGeocode.forEach((c) => {
                const coord = customerCoords.get(c.userId);
                if (!coord) return;
                const key = `${coord.lat.toFixed(3)}_${coord.lng.toFixed(3)}`;
                if (!uniqueCoords.has(key)) {
                    uniqueCoords.set(key, { lat: coord.lat, lng: coord.lng, eventIds: [] });
                }
                uniqueCoords.get(key).eventIds.push(coord.eventId);
            });

            const resolved = new Map();
            const entries = Array.from(uniqueCoords.entries()).slice(0, 50);

            for (const [key, coord] of entries) {
                try {
                    const url = `https://nominatim.openstreetmap.org/reverse?lat=${coord.lat}&lon=${coord.lng}&format=json&zoom=18&accept-language=en`;
                    const controller = new AbortController();
                    const timeout = setTimeout(() => controller.abort(), 3000);
                    const response = await fetch(url, {
                        headers: { 'User-Agent': 'AssuredRewards/1.0' },
                        signal: controller.signal
                    });
                    clearTimeout(timeout);

                    if (response.ok) {
                        const data = await response.json();
                        const addr = data?.address || {};
                        const landmark = addr.amenity || addr.building || addr.shop || addr.office || addr.leisure || '';
                        const road = addr.road || '';
                        let area = addr.suburb || addr.neighbourhood || '';
                        area = area.replace(/\s+Tehsil/gi, '');
                        const district = addr.city_district || addr.district || '';
                        const city = addr.city || addr.town || addr.village || '';
                        const state = addr.state || '';
                        
                        const displayParts = [landmark, road, area, district, city, state]
                            .filter(Boolean)
                            .map(s => s.trim());
                        
                        const uniqueParts = [];
                        displayParts.forEach(p => {
                            if (uniqueParts.length === 0 || uniqueParts[uniqueParts.length - 1] !== p) {
                                uniqueParts.push(p);
                            }
                        });
                        
                        const locationStr = uniqueParts.join(', ') || 'Unknown';
                        resolved.set(key, { locationStr, city, state });

                        const dbCityParts = [landmark, road, area, district, city]
                            .filter(Boolean)
                            .map(s => s.trim());
                        const dbCity = dbCityParts.join(', ');

                        if (dbCity || state) {
                            prisma.redemptionEvent.updateMany({
                                where: { id: { in: coord.eventIds } },
                                data: {
                                    ...(dbCity ? { city: dbCity } : {}),
                                    ...(state ? { state } : {})
                                }
                            }).catch(() => { /* ignore */ });
                        }
                    }
                } catch {
                    // Skip on timeout or error
                }
            }

            // Apply resolved locations to customers
            customers = customers.map((c) => {
                const coord = customerCoords.get(c.userId);
                if (!coord) return c;
                const key = `${coord.lat.toFixed(3)}_${coord.lng.toFixed(3)}`;
                const loc = resolved.get(key);
                if (loc) return { ...c, firstScanLocation: loc.locationStr };
                return c;
            });
        }

        // Post-processing filters on aggregated data
        if (req.query.mobile) {
            const needle = String(req.query.mobile).trim();
            customers = customers.filter((entry) => String(entry.mobile || '').includes(needle));
        }
        if (req.query.location) {
            const needle = String(req.query.location).trim().toLowerCase();
            customers = customers.filter((entry) => String(entry.firstScanLocation || '').toLowerCase().includes(needle));
        }

        const total = customers.length;
        const skip = (page - 1) * limit;
        const paged = customers
            .sort((a, b) => new Date(b.lastScanned) - new Date(a.lastScanned))
            .slice(skip, skip + limit);

        res.json({
            customers: paged,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch customers', error: error.message });
    }
};

exports.exportVendorCustomers = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const where = buildRedemptionEventWhere(vendor, req.query);
        where.type = 'redeem_success';
        where.userId = { not: null };

        const events = await prisma.redemptionEvent.findMany({
            where,
            include: {
                User: { select: { id: true, name: true, phoneNumber: true } }
            },
            orderBy: { createdAt: 'asc' },
            take: 100000
        });

        const customerMap = new Map();
        events.forEach((event) => {
            const userId = event.userId;
            if (!userId) return;
            const existing = customerMap.get(userId);
            if (!existing) {
                customerMap.set(userId, {
                    name: event.User?.name || '',
                    mobile: event.User?.phoneNumber || '',
                    codeCount: 1,
                    rewardsEarned: Number(event.amount || 0),
                    firstScanLocation: [event.city, event.state, event.pincode].filter(Boolean).join(', ') || '',
                    memberSince: event.createdAt,
                    lastScanned: event.createdAt
                });
                return;
            }
            existing.codeCount += 1;
            existing.rewardsEarned += Number(event.amount || 0);
            existing.lastScanned = event.createdAt;
        });
        
        let customerList = Array.from(customerMap.values());
        
        // Post-processing filters on aggregated data
        if (req.query.mobile) {
            const needle = String(req.query.mobile).trim();
            customerList = customerList.filter((entry) => String(entry.mobile || '').includes(needle));
        }
        if (req.query.location) {
            const needle = String(req.query.location).trim().toLowerCase();
            customerList = customerList.filter((entry) => String(entry.firstScanLocation || '').toLowerCase().includes(needle));
        }

        const header = [
            'Name',
            'Mobile',
            'Code Count',
            'Rewards Earned',
            'First Scan Location',
            'Member Since',
            'Last Scanned'
        ];
        const rows = customerList.map((entry) => [
            entry.name,
            entry.mobile,
            String(entry.codeCount),
            toNumber(entry.rewardsEarned, 0).toFixed(2),
            entry.firstScanLocation,
            new Date(entry.memberSince).toISOString(),
            new Date(entry.lastScanned).toISOString()
        ]);

        const csv = [header, ...rows]
            .map((row) => row.map(escapeCsvValue).join(','))
            .join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=\"vendor-customers-${Date.now()}.csv\"`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ message: 'Failed to export customers', error: error.message });
    }
};

exports.getVendorWalletTransactionsDetailed = async (req, res) => {
    try {
        const { vendor, wallet } = await ensureVendorAndWallet(req.user.id);
        const { page, limit, skip } = parsePagination(req, { defaultLimit: 30, maxLimit: 200 });

        const where = { walletId: wallet.id };
        if (req.query.type) where.type = req.query.type;
        if (req.query.category) where.category = req.query.category;
        if (req.query.txnId) where.id = req.query.txnId;
        if (req.query.referenceId) where.referenceId = req.query.referenceId;
        const dateRange = buildDateRange(req.query);
        if (dateRange) where.createdAt = dateRange;

        const [transactions, total, totals] = await Promise.all([
            prisma.transaction.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.transaction.count({ where }),
            prisma.transaction.groupBy({
                by: ['type'],
                where,
                _sum: { amount: true }
            })
        ]);

        const summary = totals.reduce(
            (acc, item) => {
                const amount = Number(item._sum.amount || 0);
                if (item.type === 'credit') acc.credit += amount;
                if (item.type === 'debit') acc.debit += amount;
                return acc;
            },
            { credit: 0, debit: 0 }
        );

        res.json({
            availableBalance: toNumber(wallet.balance, 0) - toNumber(wallet.lockedBalance, 0),
            lockedBalance: toNumber(wallet.lockedBalance, 0),
            totalBalance: toNumber(wallet.balance, 0),
            summary: {
                credit: toNumber(summary.credit, 0),
                debit: toNumber(summary.debit, 0),
                closingBalance: toNumber(wallet.balance, 0)
            },
            transactions,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch wallet transactions', error: error.message });
    }
};

exports.exportVendorWalletTransactions = async (req, res) => {
    try {
        const { wallet } = await ensureVendorAndWallet(req.user.id);
        const where = { walletId: wallet.id };
        if (req.query.type) where.type = req.query.type;
        if (req.query.category) where.category = req.query.category;
        const dateRange = buildDateRange(req.query);
        if (dateRange) where.createdAt = dateRange;

        const transactions = await prisma.transaction.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            take: 20000
        });

        const header = ['Date', 'Txn ID', 'Type', 'Category', 'Amount', 'Status', 'Reference ID', 'Description'];
        const rows = transactions.map((tx) => [
            new Date(tx.createdAt).toISOString(),
            tx.id,
            tx.type,
            tx.category,
            toNumber(tx.amount, 0).toFixed(2),
            tx.status,
            tx.referenceId || '',
            tx.description || ''
        ]);

        const csv = [header, ...rows]
            .map((row) => row.map(escapeCsvValue).join(','))
            .join('\n');

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=\"vendor-wallet-transactions-${Date.now()}.csv\"`);
        res.send(csv);
    } catch (error) {
        res.status(500).json({ message: 'Failed to export wallet transactions', error: error.message });
    }
};

exports.getVendorInvoices = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        try {
            await prisma.$transaction(async (tx) => {
                await backfillLegacyInvoicesForVendor(tx, vendor.id);
            });
        } catch (backfillError) {
            console.error('[Invoices] Backfill failed but continuing invoice fetch:', backfillError.message);
        }
        const { page, limit, skip } = parsePagination(req, { defaultLimit: 25, maxLimit: 100 });
        const where = { vendorId: vendor.id };
        if (req.query.invoiceNo) {
            where.number = { contains: String(req.query.invoiceNo).trim(), mode: 'insensitive' };
        }
        if (req.query.campaignId) {
            where.campaignBudgetId = {
                in: (await prisma.campaignBudget.findMany({
                    where: { campaignId: req.query.campaignId, vendorId: vendor.id },
                    select: { id: true }
                })).map(b => b.id)
            };
        }
        const dateRange = buildDateRange(req.query);
        if (dateRange) where.issuedAt = dateRange;

        const [invoices, total] = await Promise.all([
            prisma.invoice.findMany({
                where,
                include: {
                    Items: true
                },
                orderBy: { issuedAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.invoice.count({ where })
        ]);

        res.json({
            invoices,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch invoices', error: error.message });
    }
};

const isMissingColumnError = (error) => {
    if (!error) return false;
    const message = String(error.message || '');
    return (
        error.code === 'P2022' ||
        message.includes('ColumnNotFound') ||
        message.includes('does not exist in the current database')
    );
};

const sanitizeDownloadFileStem = (value, fallback = 'invoice') => {
    const cleaned = String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '')
        .trim();
    const safe = cleaned || fallback;
    return safe.slice(0, 120);
};

const buildInvoicePdfPayload = async (invoiceId, vendorId) => {
    const baseWhere = { id: invoiceId, vendorId };

    try {
        return await prisma.invoice.findFirst({
            where: baseWhere,
            select: {
                id: true,
                number: true,
                type: true,
                subtotal: true,
                tax: true,
                total: true,
                issuedAt: true,
                vendorId: true,
                brandId: true,
                Items: {
                    select: {
                        id: true,
                        label: true,
                        qty: true,
                        unitPrice: true,
                        amount: true,
                        hsnSac: true,
                        taxRate: true
                    },
                    orderBy: { createdAt: 'asc' }
                },
                Vendor: {
                    select: {
                        businessName: true,
                        contactPhone: true,
                        contactEmail: true
                    }
                },
                Brand: {
                    select: {
                        id: true,
                        name: true
                    }
                }
            }
        });
    } catch (error) {
        if (!isMissingColumnError(error)) throw error;
        console.error('[InvoicePDF] Primary query failed, trying fallback:', error.message);
    }

    const baseInvoice = await prisma.invoice.findFirst({
        where: baseWhere,
        select: {
            id: true,
            number: true,
            type: true,
            subtotal: true,
            tax: true,
            total: true,
            issuedAt: true,
            vendorId: true,
            brandId: true
        }
    });

    if (!baseInvoice) {
        return null;
    }

    let items = [];
    try {
        items = await prisma.invoiceItem.findMany({
            where: { invoiceId: baseInvoice.id },
            select: {
                id: true,
                label: true,
                qty: true,
                unitPrice: true,
                amount: true,
                hsnSac: true,
                taxRate: true
            },
            orderBy: { createdAt: 'asc' }
        });
    } catch (error) {
        if (!isMissingColumnError(error)) throw error;
        console.error('[InvoicePDF] Invoice items fallback query failed:', error.message);
    }

    let vendor = null;
    try {
        vendor = await prisma.vendor.findUnique({
            where: { id: baseInvoice.vendorId },
            select: {
                businessName: true,
                contactPhone: true,
                contactEmail: true
            }
        });
    } catch (error) {
        if (!isMissingColumnError(error)) throw error;
        console.error('[InvoicePDF] Vendor fallback query failed, trying minimal vendor fields:', error.message);
        vendor = await prisma.vendor.findUnique({
            where: { id: baseInvoice.vendorId },
            select: {
                businessName: true,
                contactPhone: true
            }
        });
    }

    let brand = null;
    if (baseInvoice.brandId) {
        try {
            brand = await prisma.brand.findUnique({
                where: { id: baseInvoice.brandId },
                select: {
                    id: true,
                    name: true
                }
            });
        } catch (error) {
            if (!isMissingColumnError(error)) throw error;
            console.error('[InvoicePDF] Brand fallback query failed:', error.message);
        }
    }

    return {
        ...baseInvoice,
        Items: items,
        Vendor: vendor,
        Brand: brand
    };
};

const sendInvoicePdfResponse = async (res, invoice) => {
    const pdfBuffer = await renderInvoiceToBuffer(invoice);
    const fallbackStem = `invoice-${String(invoice?.id || Date.now()).slice(-8)}`;
    const safeStem = sanitizeDownloadFileStem(invoice?.number, fallbackStem);
    const safeFileName = `${safeStem}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
        'Content-Disposition',
        `attachment; filename="${safeFileName}"; filename*=UTF-8''${encodeURIComponent(safeFileName)}`
    );
    res.send(pdfBuffer);
};

exports.downloadVendorInvoicePdf = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const invoice = await buildInvoicePdfPayload(req.params.id, vendor.id);

        if (!invoice) {
            return res.status(404).json({ message: 'Invoice not found' });
        }

        await sendInvoicePdfResponse(res, invoice);
    } catch (error) {
        console.error('[InvoicePDF] downloadVendorInvoicePdf failed:', {
            invoiceId: req.params?.id,
            userId: req.user?.id,
            message: error?.message
        });
        res.status(500).json({ message: 'Failed to download invoice', error: error.message });
    }
};

exports.shareVendorInvoice = async (req, res) => {
    try {
        const { vendor } = await ensureVendorAndWallet(req.user.id);
        const invoice = await prisma.invoice.findFirst({
            where: {
                id: req.params.id,
                vendorId: vendor.id
            }
        });
        if (!invoice) {
            return res.status(404).json({ message: 'Invoice not found' });
        }

        const result = await prisma.$transaction((tx) => withShareToken(tx, invoice.id, 72));
        const shareUrl = `${req.protocol}://${req.get('host')}/api/public/invoices/shared/${result.token}/invoice.pdf`;

        res.json({
            shareToken: result.token,
            shareUrl,
            shareExpiresAt: result.expiry
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to share invoice', error: error.message });
    }
};

exports.getSharedInvoice = async (req, res) => {
    try {
        const token = String(req.params.token || '').trim();
        if (!token) {
            return res.status(400).json({ message: 'Invalid share token' });
        }

        const invoice = await prisma.invoice.findFirst({
            where: {
                shareToken: token,
                shareExpiresAt: { gt: new Date() },
                status: 'issued'
            },
            include: {
                Items: true,
                Vendor: true,
                Brand: true
            }
        });

        if (!invoice) {
            return res.status(404).json({ message: 'Shared invoice not found or expired' });
        }

        if (String(req.query.format || '').toLowerCase() === 'json') {
            return res.json({
                invoice: {
                    id: invoice.id,
                    number: invoice.number,
                    type: invoice.type,
                    subtotal: toNumber(invoice.subtotal, 0),
                    tax: toNumber(invoice.tax, 0),
                    total: toNumber(invoice.total, 0),
                    issuedAt: invoice.issuedAt,
                    vendor: invoice.Vendor
                        ? {
                            businessName: invoice.Vendor.businessName,
                            contactEmail: invoice.Vendor.contactEmail
                        }
                        : null,
                    brand: invoice.Brand
                        ? {
                            id: invoice.Brand.id,
                            name: invoice.Brand.name
                        }
                        : null,
                    items: invoice.Items
                }
            });
        }

        await sendInvoicePdfResponse(res, invoice);
    } catch (error) {
        res.status(500).json({ message: 'Failed to open shared invoice', error: error.message });
    }
};


