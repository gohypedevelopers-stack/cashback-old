const prisma = require('../config/prismaClient');
const { safeLogActivity } = require('../utils/activityLogger');
const { encrypt, decrypt } = require('../utils/encryption');

// Process Payout (Admin/System use)
exports.processPayout = async (req, res) => {
    try {
        const { withdrawalId, status, referenceId, adminNote, rejectionReason } = req.body;

        const withdrawal = await prisma.withdrawal.findUnique({
            where: { id: withdrawalId },
            include: {
                Wallet: { include: { User: true } },
                PayoutMethod: true
            }
        });

        if (!withdrawal) {
            return res.status(404).json({ success: false, message: 'Withdrawal not found' });
        }

        if (!['completed', 'failed'].includes(status)) {
            return res.status(400).json({ success: false, message: 'Invalid status. Use completed or failed.' });
        }

        if (withdrawal.status === 'processing') {
            return res.status(400).json({
                success: false,
                message: 'Payout is being processed by the bank; use requery'
            });
        }

        if (!['pending', 'on_hold'].includes(withdrawal.status)) {
            return res.status(400).json({
                success: false,
                message: 'Withdrawal already processed'
            });
        }

        // Wallet movement (success: balance & lockedBalance -= amount;
        // failure: lockedBalance -= amount) is applied idempotently by the service.
        const rblPayoutService = require('../services/rblPayoutService');
        const result = await rblPayoutService.finalizeManually(withdrawalId, status, {
            referenceId,
            adminNote,
            reason: rejectionReason
        });

        const wallet = withdrawal.Wallet;
        const amount = parseFloat(withdrawal.amount);
        let decryptedValue;
        try { decryptedValue = decrypt(withdrawal.PayoutMethod.value); } catch (e) { decryptedValue = 'your UPI'; }

        // Notify user (best-effort; wallet is already finalized)
        if (wallet.userId) {
            try {
                if (status === 'completed') {
                    await prisma.notification.create({
                        data: {
                            userId: wallet.userId,
                            title: 'Payout Successful',
                            message: `₹${amount} has been sent to your UPI: ${decryptedValue}`,
                            type: 'payout-success',
                            metadata: {
                                withdrawalId: withdrawal.id,
                                amount: amount,
                                upi: decryptedValue
                            }
                        }
                    });
                } else {
                    await prisma.notification.create({
                        data: {
                            userId: wallet.userId,
                            title: 'Payout Failed',
                            message: `Payout of ₹${amount} failed. ${rejectionReason || 'Please try again or contact support.'}`,
                            type: 'payout-failed',
                            metadata: {
                                withdrawalId: withdrawal.id,
                                amount: amount,
                                reason: rejectionReason
                            }
                        }
                    });
                }
            } catch (notifyError) {
                console.error('Payout notification error:', notifyError.message);
            }
        }

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            action: 'payout_processed',
            entityType: 'withdrawal',
            entityId: withdrawalId,
            metadata: {
                status,
                amount: parseFloat(withdrawal.amount),
                referenceId
            },
            req
        });

        res.json({
            success: true,
            message: `Payout ${status} successfully`,
            withdrawal: {
                id: result?.id || withdrawalId,
                status: result?.status || status,
                amount: parseFloat(result?.amount ?? withdrawal.amount)
            }
        });

    } catch (error) {
        console.error('Process payout error:', error);
        res.status(error.statusCode || 500).json({
            success: false,
            message: 'Failed to process payout',
            error: error.message
        });
    }
};

// Get all withdrawals (Admin)
exports.getAllWithdrawals = async (req, res) => {
    try {
        const { status, page = 1, limit = 20 } = req.query;

        const where = {};
        if (status) where.status = status;

        const total = await prisma.withdrawal.count({ where });

        const withdrawals = await prisma.withdrawal.findMany({
            where,
            include: {
                Wallet: {
                    include: {
                        User: { select: { id: true, name: true, phoneNumber: true } }
                    }
                },
                PayoutMethod: true
            },
            orderBy: { createdAt: 'desc' },
            skip: (parseInt(page) - 1) * parseInt(limit),
            take: parseInt(limit)
        });

        res.json({
            success: true,
            withdrawals: withdrawals.map(w => ({
                id: w.id,
                amount: parseFloat(w.amount),
                status: w.status,
                user: w.Wallet.User,
                payoutMethod: (function() {
                    try { return decrypt(w.PayoutMethod.value); } catch(e) { return w.PayoutMethod.value; }
                })(),
                referenceId: w.referenceId,
                createdAt: w.createdAt,
                updatedAt: w.updatedAt
            })),
            pagination: {
                page: parseInt(page),
                limit: parseInt(limit),
                total,
                pages: Math.ceil(total / parseInt(limit))
            }
        });

    } catch (error) {
        console.error('Get all withdrawals error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to fetch withdrawals',
            error: error.message
        });
    }
};

// Add UPI ID
exports.addUPIMethod = async (req, res) => {
    try {
        const userId = req.user.id;
        const { upiId, setAsPrimary } = req.body;

        // Validate UPI format
        const upiRegex = /^[a-zA-Z0-9._-]+@[a-zA-Z]+$/;
        if (!upiRegex.test(upiId)) {
            return res.status(400).json({
                success: false,
                message: 'Invalid UPI ID format'
            });
        }

        // Check if UPI already exists
        const existing = await prisma.payoutMethod.findFirst({
            where: { userId, value: upiId }
        });

        if (existing) {
            return res.status(400).json({
                success: false,
                message: 'This UPI ID is already saved'
            });
        }

        const result = await prisma.$transaction(async (tx) => {
            // If setting as primary, unset other primary methods
            if (setAsPrimary) {
                await tx.payoutMethod.updateMany({
                    where: { userId, isPrimary: true },
                    data: { isPrimary: false }
                });
            }

            // Create new payout method
            const method = await tx.payoutMethod.create({
                data: {
                    userId,
                    type: 'upi',
                    value: encrypt(upiId),
                    isPrimary: setAsPrimary || false
                }
            });

            return method;
        });

        res.json({
            success: true,
            message: 'UPI ID added successfully',
            payoutMethod: {
                id: result.id,
                value: result.value,
                isPrimary: result.isPrimary
            }
        });

    } catch (error) {
        console.error('Add UPI method error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to add UPI ID',
            error: error.message
        });
    }
};

// Set primary UPI
exports.setPrimaryUPI = async (req, res) => {
    try {
        const userId = req.user.id;
        const { methodId } = req.body;

        // Verify method belongs to user
        const method = await prisma.payoutMethod.findUnique({
            where: { id: methodId }
        });

        if (!method || method.userId !== userId) {
            return res.status(404).json({
                success: false,
                message: 'Payout method not found'
            });
        }

        await prisma.$transaction(async (tx) => {
            // Unset all primary
            await tx.payoutMethod.updateMany({
                where: { userId, isPrimary: true },
                data: { isPrimary: false }
            });

            // Set new primary
            await tx.payoutMethod.update({
                where: { id: methodId },
                data: { isPrimary: true }
            });
        });

        res.json({
            success: true,
            message: 'Primary UPI updated successfully'
        });

    } catch (error) {
        console.error('Set primary UPI error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to update primary UPI',
            error: error.message
        });
    }
};

// Delete UPI method
exports.deleteUPIMethod = async (req, res) => {
    try {
        const userId = req.user.id;
        const { id } = req.params;

        // Verify method belongs to user
        const method = await prisma.payoutMethod.findUnique({
            where: { id }
        });

        if (!method || method.userId !== userId) {
            return res.status(404).json({
                success: false,
                message: 'Payout method not found'
            });
        }

        // Check if there are pending withdrawals using this method
        const pendingWithdrawals = await prisma.withdrawal.count({
            where: {
                payoutMethodId: id,
                status: { in: ['pending', 'processing', 'on_hold'] }
            }
        });

        if (pendingWithdrawals > 0) {
            return res.status(400).json({
                success: false,
                message: 'Cannot delete UPI ID with pending withdrawals'
            });
        }

        await prisma.payoutMethod.delete({ where: { id } });

        res.json({
            success: true,
            message: 'UPI ID deleted successfully'
        });

    } catch (error) {
        console.error('Delete UPI method error:', error);
        res.status(500).json({
            success: false,
            message: 'Failed to delete UPI ID',
            error: error.message
        });
    }
};

module.exports = exports;
