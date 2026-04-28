const prisma = require('../config/prismaClient');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { parsePagination } = require('../utils/pagination');
const { safeLogActivity } = require('../utils/activityLogger');
const { seedVendorInventory } = require('../services/qrInventoryService');
const { ensureVendorWallet } = require('../services/walletService');

const slugifyBrandName = (value = 'brand') => {
    return value
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || 'brand';
};

const generatePassword = () =>
    String(crypto.randomInt(0, 10 ** 8)).padStart(8, '0');

const generateUniqueUsername = async (tx, name) => {
    const base = slugifyBrandName(name);
    let candidate = base;
    let counter = 0;
    while (await tx.user.findUnique({ where: { username: candidate } })) {
        counter += 1;
        candidate = `${base}${counter}`;
    }
    return candidate;
};

const parseAmount = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    return Number(numeric.toFixed(2));
};

const DEFAULT_VENDOR_QR_INVENTORY = Number(process.env.DEFAULT_VENDOR_QR_INVENTORY || 0);
const MAX_QR_PRICE = 100;

const parseQrPrice = (value) => {
    if (value === undefined || value === null || value === '') return null;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric > MAX_QR_PRICE) return null;
    return Number(numeric.toFixed(2));
};

const createVendorAccount = async (tx, { brandName, email, phone }) => {
    const username = await generateUniqueUsername(tx, brandName);
    const password = generatePassword();
    const hashedPassword = await bcrypt.hash(password, 10);
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : null;
    const normalizedPhone = typeof phone === 'string' ? phone.trim() : null;
    const existingEmailUser = normalizedEmail
        ? await tx.user.findUnique({ where: { email: normalizedEmail } })
        : null;
    const userEmail = existingEmailUser || !normalizedEmail ? null : normalizedEmail;

    const user = await tx.user.create({
        data: {
            name: brandName,
            email: userEmail,
            username,
            password: hashedPassword,
            role: 'vendor',
            status: 'active'
        }
    });

    const vendor = await tx.vendor.create({
        data: {
            userId: user.id,
            businessName: brandName,
            contactEmail: normalizedEmail || null,
            contactPhone: normalizedPhone || null,
            status: 'active'
        }
    });

    return { user, vendor, credentials: { username, password } };
};

// --- Brand Management ---

exports.createBrand = async (req, res) => {
    try {
        const { name, logoUrl, website, vendorEmail, vendorPhone, vendorId, qrPricePerUnit } = req.body;

        if (!name) {
            return res.status(400).json({ message: 'Brand name is required' });
        }

        const normalizedQrPrice = parseQrPrice(qrPricePerUnit);
        if (qrPricePerUnit !== undefined && qrPricePerUnit !== '' && normalizedQrPrice === null) {
            return res.status(400).json({ message: `QR price per unit must be between 0.01 and ${MAX_QR_PRICE}` });
        }

        const normalizedEmail = typeof vendorEmail === 'string' ? vendorEmail.trim().toLowerCase() : null;
        const normalizedPhone = typeof vendorPhone === 'string' ? vendorPhone.trim() : null;

        const result = await prisma.$transaction(async (tx) => {
            let vendor = null;
            let user = null;
            let credentials = null;

            if (vendorId) {
                vendor = await tx.vendor.findUnique({
                    where: { id: vendorId },
                    include: { User: true, Brand: true }
                });
                if (!vendor) {
                    throw new Error('Vendor not found for the provided vendorId');
                }
                user = vendor.User || null;
            }

            if (!vendor && normalizedEmail) {
                user = await tx.user.findUnique({ where: { email: normalizedEmail } });
                if (user) {
                    if (user.role === 'admin') {
                        throw new Error('Admin accounts cannot be assigned as vendors');
                    }
                    if (user.role !== 'vendor') {
                        user = await tx.user.update({
                            where: { id: user.id },
                            data: { role: 'vendor', status: 'active' }
                        });
                    }
                    vendor = await tx.vendor.findUnique({
                        where: { userId: user.id },
                        include: { User: true, Brand: true }
                    });
                    if (!vendor) {
                        vendor = await tx.vendor.create({
                            data: {
                                userId: user.id,
                                businessName: name,
                                contactEmail: normalizedEmail || null,
                                contactPhone: normalizedPhone || null,
                                status: 'active'
                            },
                            include: { User: true }
                        });
                    }
                }
            }

            if (vendor?.Brand) {
                throw new Error('This vendor already has a brand assigned');
            }

            if (!vendor) {
                const created = await createVendorAccount(tx, {
                    brandName: name,
                    email: normalizedEmail,
                    phone: normalizedPhone
                });
                vendor = created.vendor;
                user = created.user;
                credentials = created.credentials;
            }

            if (user && normalizedEmail && !user.email) {
                await tx.user.update({
                    where: { id: user.id },
                    data: { email: normalizedEmail }
                });
            }

            if (vendor && (normalizedEmail || normalizedPhone)) {
                const vendorUpdates = {};
                if (normalizedEmail && !vendor.contactEmail) vendorUpdates.contactEmail = normalizedEmail;
                if (normalizedPhone && !vendor.contactPhone) vendorUpdates.contactPhone = normalizedPhone;
                if (!vendor.businessName && name) vendorUpdates.businessName = name;
                if (Object.keys(vendorUpdates).length) {
                    vendor = await tx.vendor.update({
                        where: { id: vendor.id },
                        data: vendorUpdates
                    });
                }
            }

            const brand = await tx.brand.create({
                data: {
                    name,
                    logoUrl,
                    website,
                    status: 'active',
                    vendorId: vendor.id,
                    ...(normalizedQrPrice !== null ? { qrPricePerUnit: normalizedQrPrice } : {})
                }
            });

            return { brand, vendor, credentials };
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: result.vendor?.id,
            brandId: result.brand?.id,
            action: 'brand_create',
            entityType: 'brand',
            entityId: result.brand?.id,
            metadata: {
                name
            },
            req
        });

        res.status(201).json({
            message: 'Brand and vendor created successfully',
            ...result
        });
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(409).json({
                message: 'Brand creation failed due to a duplicate value.',
                error: error.message
            });
        }
        const message = error.message || 'Error creating brand';
        const status = message.includes('already has a brand') || message.includes('not found')
            ? 400
            : 500;
        res.status(status).json({ message, error: error.message });
    }
};

exports.getAllBrands = async (req, res) => {
    try {
        const { status, vendorId } = req.query;
        const where = {};
        if (status) where.status = status;
        if (vendorId) where.vendorId = vendorId;

        const shouldPaginate = req.query.page || req.query.limit;
        if (shouldPaginate) {
            const { page, limit, skip } = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
            const [brands, total] = await Promise.all([
                prisma.brand.findMany({
                    where,
                    include: {
                        Vendor: {
                            select: { businessName: true, contactPhone: true, status: true }
                        }
                    },
                    orderBy: { createdAt: 'desc' },
                    skip,
                    take: limit
                }),
                prisma.brand.count({ where })
            ]);

            return res.json({
                items: brands,
                total,
                page,
                pages: total ? Math.ceil(total / limit) : 0
            });
        }

        const brands = await prisma.brand.findMany({
            where,
            include: {
                Vendor: {
                    select: { businessName: true, contactPhone: true, status: true }
                }
            },
            orderBy: { createdAt: 'desc' }
        });
        res.json(brands);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching brands', error: error.message });
    }
};

// --- Campaign Management ---

exports.createCampaign = async (req, res) => {
    try {
        const { brandId, title, description, cashbackAmount, startDate, endDate, totalBudget, status } = req.body;

        // Validation: Check if Brand exists
        const brand = await prisma.brand.findUnique({ where: { id: brandId } });
        if (!brand) return res.status(404).json({ message: 'Brand not found' });

        const normalizedStatus = ['active', 'paused', 'pending', 'rejected', 'completed'].includes(status)
            ? status
            : 'active';

        const campaign = await prisma.campaign.create({
            data: {
                brandId,
                title,
                description,
                cashbackAmount,
                startDate: new Date(startDate),
                endDate: new Date(endDate),
                totalBudget,
                status: normalizedStatus
            }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: brand.vendorId || undefined,
            brandId,
            campaignId: campaign.id,
            action: 'campaign_create',
            entityType: 'campaign',
            entityId: campaign.id,
            metadata: {
                title,
                status: normalizedStatus
            },
            req
        });

        res.status(201).json(campaign);
    } catch (error) {
        res.status(500).json({ message: 'Error creating campaign', error: error.message });
    }
};

exports.getAllCampaigns = async (req, res) => {
    try {
        const { type, brandId, vendorId, status } = req.query; // 'admin' or 'vendor'
        const where = {};
        const brandWhere = {};

        if (brandId) {
            where.brandId = brandId;
        }

        if (status) {
            where.status = status;
        }

        if (type === 'admin') {
            brandWhere.vendorId = null;
        } else if (type === 'vendor') {
            brandWhere.vendorId = { not: null };
        }

        if (vendorId) {
            brandWhere.vendorId = vendorId;
        }

        if (Object.keys(brandWhere).length) {
            where.Brand = brandWhere;
        }

        const shouldPaginate = req.query.page || req.query.limit;
        if (shouldPaginate) {
            const { page, limit, skip } = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
            const [campaigns, total] = await Promise.all([
                prisma.campaign.findMany({
                    where,
                    include: { Brand: { include: { Vendor: { select: { businessName: true } } } } },
                    orderBy: { createdAt: 'desc' },
                    skip,
                    take: limit
                }),
                prisma.campaign.count({ where })
            ]);

            return res.json({
                items: campaigns,
                total,
                page,
                pages: total ? Math.ceil(total / limit) : 0
            });
        }

        const campaigns = await prisma.campaign.findMany({
            where,
            include: { Brand: { include: { Vendor: { select: { businessName: true } } } } },
            orderBy: { createdAt: 'desc' }
        });
        res.json(campaigns);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching campaigns', error: error.message });
    }
};

exports.deleteCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const campaign = await prisma.campaign.findUnique({ where: { id } });

        if (!campaign) return res.status(404).json({ message: 'Campaign not found' });

        const brand = await prisma.brand.findUnique({ where: { id: campaign.brandId } });

        await prisma.$transaction(async (tx) => {
            await tx.bulkExportJob.deleteMany({ where: { campaignId: id } }).catch(() => { });
            await tx.qRCode.deleteMany({ where: { campaignId: id } });
            await tx.campaign.delete({ where: { id } });
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: brand?.vendorId,
            brandId: campaign.brandId,
            campaignId: id,
            action: 'campaign_delete',
            entityType: 'campaign',
            entityId: id,
            metadata: { title: campaign.title },
            req
        });

        res.json({ message: 'Campaign deleted', campaignId: id });
    } catch (error) {
        res.status(500).json({ message: 'Delete failed', error: error.message });
    }
};

// --- Vendor Management (Admin View) ---

exports.getAllVendors = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const [vendors, total] = await Promise.all([
            prisma.vendor.findMany({
                where: {},
                include: {
                    User: true,
                    Wallet: true,
                    Brand: true
                },
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' }
            }),
            prisma.vendor.count({
                where: {}
            })
        ]);

        res.json({
            vendors,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching vendors', error: error.message });
    }
};

exports.deleteProduct = async (req, res) => {
    try {
        const { id } = req.params;
        // Admin force delete (no ownership check needed really, just existence)
        await prisma.product.delete({ where: { id } });
        res.json({ message: 'Product forcibly deleted by Admin' });
    } catch (error) {
        res.status(500).json({ message: 'Delete failed', error: error.message });
    }
};

exports.createVendorProfile = async (req, res) => {
    const { name, email, password, businessName, contactPhone, gstin } = req.body;

    if (!email || !password || !businessName) {
        return res.status(400).json({ message: 'Email, password, and business name are required' });
    }

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        let user = await prisma.user.findUnique({ where: { email } });

        if (user) {
            user = await prisma.user.update({
                where: { email },
                data: {
                    name,
                    password: hashedPassword,
                    role: 'vendor',
                    status: 'active'
                }
            });
        } else {
            user = await prisma.user.create({
                data: {
                    name,
                    email,
                    password: hashedPassword,
                    role: 'vendor',
                    status: 'active'
                }
            });
        }

        const vendor = await prisma.vendor.upsert({
            where: { userId: user.id },
            update: {
                businessName,
                contactPhone,
                gstin,
                status: 'active'
            },
            create: {
                userId: user.id,
                businessName,
                contactPhone,
                gstin,
                status: 'active'
            }
        });

        await prisma.wallet.upsert({
            where: { vendorId: vendor.id },
            update: {
                userId: user.id
            },
            create: {
                vendorId: vendor.id,
                userId: user.id,
                balance: 0,
                lockedBalance: 0,
                currency: 'INR'
            }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: vendor.id,
            action: 'vendor_create',
            entityType: 'vendor',
            entityId: vendor.id,
            metadata: {
                businessName,
                email: user.email
            },
            req
        });

        res.status(201).json({
            vendor,
            credentials: {
                email: user.email,
                password
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error creating vendor', error: error.message });
    }
};

exports.verifyBrand = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body; // Allow passing 'active' or 'rejected'

        const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : 'active';
        const allowedStatuses = ['active', 'inactive', 'pending', 'rejected'];
        if (!allowedStatuses.includes(normalizedStatus)) {
            return res.status(400).json({ message: 'Invalid brand status' });
        }

        const brand = await prisma.brand.update({
            where: { id },
            data: {
                status: normalizedStatus,
                rejectionReason: normalizedStatus === 'rejected' ? reason : null
            }
        });

        if (brand.vendorId && normalizedStatus === 'rejected') {
            const vendor = await prisma.vendor.update({
                where: { id: brand.vendorId },
                data: {
                    status: 'rejected',
                    rejectionReason: reason || null
                }
            });
            await prisma.user.update({
                where: { id: vendor.userId },
                data: { status: 'inactive' }
            });
        } else if (brand.vendorId && normalizedStatus === 'inactive') {
            const vendor = await prisma.vendor.update({
                where: { id: brand.vendorId },
                data: { status: 'paused' }
            });
            await prisma.user.update({
                where: { id: vendor.userId },
                data: { status: 'inactive' }
            });
        }

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: brand.vendorId || undefined,
            brandId: brand.id,
            action: 'brand_status_update',
            entityType: 'brand',
            entityId: brand.id,
            metadata: {
                status: normalizedStatus,
                reason: reason || null
            },
            req
        });

        res.json({ message: `Brand ${normalizedStatus}`, brand });
    } catch (error) {
        res.status(500).json({ message: 'Verification failed', error: error.message });
    }
};

exports.verifyCampaign = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;

        const newStatus = status === 'rejected' ? 'rejected' : 'active';

        const campaign = await prisma.campaign.update({
            where: { id },
            data: {
                status: newStatus,
                rejectionReason: newStatus === 'rejected' ? reason : null
            }
        });

        const brand = await prisma.brand.findUnique({ where: { id: campaign.brandId } });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: brand?.vendorId,
            brandId: campaign.brandId,
            campaignId: campaign.id,
            action: 'campaign_verify',
            entityType: 'campaign',
            entityId: campaign.id,
            metadata: {
                status: newStatus,
                reason: reason || null
            },
            req
        });

        res.json({ message: `Campaign ${newStatus}`, campaign });
    } catch (error) {
        res.status(500).json({ message: 'Verification failed', error: error.message });
    }
};

exports.verifyVendor = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, reason } = req.body;
        const normalizedStatus = typeof status === 'string' ? status.toLowerCase() : 'active';
        const allowedStatuses = ['pending', 'active', 'paused', 'rejected', 'expired'];

        if (!allowedStatuses.includes(normalizedStatus)) {
            return res.status(400).json({ message: 'Invalid vendor status' });
        }

        const shouldStoreReason = ['rejected', 'paused'].includes(normalizedStatus);
        const reasonValue = shouldStoreReason ? (reason || null) : null;

        const existingVendor = await prisma.vendor.findUnique({ where: { id } });
        if (!existingVendor) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        let inventorySeeded = { created: 0, total: 0 };
        const vendor = await prisma.$transaction(async (tx) => {
            const updatedVendor = await tx.vendor.update({
                where: { id },
                data: {
                    status: normalizedStatus,
                    rejectionReason: reasonValue
                }
            });

            // SECURITY: Sync User status with Vendor status
            // If vendor is active, user must be active to log in.
            // If vendor is NOT active, user should be inactive to block access.
            await tx.user.update({
                where: { id: updatedVendor.userId },
                data: { status: normalizedStatus === 'active' ? 'active' : 'inactive' }
            });

            if (normalizedStatus === 'active' && existingVendor.status !== 'active') {
                await ensureVendorWallet(tx, updatedVendor.id);
                if (DEFAULT_VENDOR_QR_INVENTORY > 0) {
                    inventorySeeded = await seedVendorInventory(
                        tx,
                        updatedVendor.id,
                        DEFAULT_VENDOR_QR_INVENTORY
                    );
                }
            }

            return updatedVendor;
        });

        const brand = await prisma.brand.findUnique({ where: { vendorId: vendor.id } });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: vendor.id,
            brandId: brand?.id,
            action: 'vendor_status_update',
            entityType: 'vendor',
            entityId: vendor.id,
            metadata: {
                status: normalizedStatus,
                reason: reason || null
            },
            req
        });

        if (normalizedStatus === 'paused' && reason) {
            safeLogActivity({
                actorUserId: req.user?.id,
                actorRole: req.user?.role,
                vendorId: vendor.id,
                brandId: brand?.id,
                action: 'vendor_flagged',
                entityType: 'vendor',
                entityId: vendor.id,
                metadata: {
                    reason
                },
                req
            });
        }
        res.json({
            message: `Vendor ${normalizedStatus}`,
            vendor,
            inventorySeeded
        });
    } catch (error) {
        res.status(500).json({ message: 'Verification failed', error: error.message });
    }
};

// --- Update Vendor Credentials ---
exports.updateVendorCredentials = async (req, res) => {
    try {
        const vendorId = req.params.vendorId || req.params.id;
        const { username, password, autoGeneratePassword } = req.body;

        if (!vendorId) {
            return res.status(400).json({ message: 'vendorId is required' });
        }

        if (!username && !password && !autoGeneratePassword) {
            return res.status(400).json({
                message: 'At least one of username, password, or autoGeneratePassword must be provided'
            });
        }

        // Find vendor with user
        const vendor = await prisma.vendor.findUnique({
            where: { id: vendorId },
            include: {
                User: true,
                Brand: { select: { id: true, name: true } }
            }
        });

        if (!vendor || !vendor.User) {
            return res.status(404).json({ message: 'Vendor or associated user not found' });
        }

        const updateData = {};
        let newPassword = null;

        // Handle username update
        if (username && username.trim()) {
            const normalizedUsername = username.trim().toLowerCase();

            // Check if username is already taken by another user
            const existingUser = await prisma.user.findUnique({
                where: { username: normalizedUsername }
            });

            if (existingUser && existingUser.id !== vendor.User.id) {
                return res.status(409).json({
                    message: 'Username already taken',
                    field: 'username'
                });
            }

            updateData.username = normalizedUsername;
        }

        // Handle password update
        if (autoGeneratePassword) {
            newPassword = generatePassword();
            updateData.password = await bcrypt.hash(newPassword, 10);
        } else if (password && password.trim()) {
            if (password.length < 6) {
                return res.status(400).json({
                    message: 'Password must be at least 6 characters long',
                    field: 'password'
                });
            }
            newPassword = password;
            updateData.password = await bcrypt.hash(password, 10);
        }

        // Update user record
        const updatedUser = await prisma.user.update({
            where: { id: vendor.User.id },
            data: updateData
        });

        // Log activity
        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: vendor.id,
            brandId: vendor.Brand?.id,
            action: 'vendor_credentials_update',
            entityType: 'vendor',
            entityId: vendor.id,
            metadata: {
                updatedFields: Object.keys(updateData),
                businessName: vendor.businessName,
                autoGenerated: autoGeneratePassword || false
            },
            req
        });

        // Return response with new credentials (only if password was updated)
        const response = {
            message: 'Vendor credentials updated successfully',
            vendor: {
                id: vendor.id,
                businessName: vendor.businessName
            },
            credentials: {
                username: updatedUser.username,
                ...(newPassword && { password: newPassword })
            }
        };

        res.json(response);
    } catch (error) {
        console.error('Update credentials error:', error);
        res.status(500).json({
            message: 'Failed to update vendor credentials',
            error: error.message
        });
    }
};


exports.processWithdrawal = async (req, res) => {
    try {
        const { id } = req.params;
        const { status, referenceId, adminNote, reason } = req.body; // status: 'processed' or 'rejected'

        if (!['processed', 'rejected'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const result = await prisma.$transaction(async (tx) => {
            const withdrawal = await tx.withdrawal.findUnique({ where: { id } });
            if (!withdrawal) throw new Error('Withdrawal request not found');
            if (withdrawal.status !== 'pending') throw new Error('Request already handled');

            // Update Withdrawal
            const updatedWithdrawal = await tx.withdrawal.update({
                where: { id },
                data: {
                    status,
                    referenceId,
                    adminNote,
                    rejectionReason: status === 'rejected' ? reason : null
                }
            });

            if (status === 'rejected') {
                // Refund Balance
                await tx.wallet.update({
                    where: { id: withdrawal.walletId },
                    data: { balance: { increment: withdrawal.amount } }
                });

                // Log Refund Transaction
                await tx.transaction.create({
                    data: {
                        walletId: withdrawal.walletId,
                        type: 'credit',
                        amount: withdrawal.amount,
                        category: 'refund',
                        status: 'success',
                        description: `Refund: Withdrawal Rejected. Reason: ${reason || adminNote || ''}`
                    }
                });
            }

            return updatedWithdrawal;
        });

        const enrichedWithdrawal = await prisma.withdrawal.findUnique({
            where: { id: result.id },
            include: {
                Wallet: {
                    include: {
                        Vendor: true,
                        User: true
                    }
                }
            }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: enrichedWithdrawal?.Wallet?.Vendor?.id,
            action: 'withdrawal_update',
            entityType: 'withdrawal',
            entityId: result.id,
            metadata: {
                status,
                referenceId,
                reason: reason || adminNote || null
            },
            req
        });

        res.json({ message: `Withdrawal ${status}`, result });

    } catch (error) {
        res.status(500).json({ message: 'Processing failed', error: error.message });
    }
};

// --- System Analytics ---

exports.getSystemStats = async (req, res) => {
    try {
        const [
            userCount,
            vendorCount,
            brandCount,
            activeCampaigns,
            totalCampaigns,
            totalTransactions,
            totalQrs,
            redeemedQrs,
            walletBalance,
            creditSum,
            debitSum,
            userStatusGroups,
            vendorStatusGroups,
            pendingWithdrawalsCount,
            ordersAttentionCount
        ] = await Promise.all([
            prisma.user.count({ where: { role: 'customer' } }),
            prisma.vendor.count(),
            prisma.brand.count(),
            prisma.campaign.count({ where: { status: 'active' } }),
            prisma.campaign.count(),
            prisma.transaction.count(),
            prisma.qRCode.count(),
            prisma.qRCode.count({ where: { status: 'redeemed' } }),
            prisma.wallet.aggregate({
                _sum: { balance: true }
            }),
            prisma.transaction.aggregate({
                where: { type: 'credit', status: 'success' },
                _sum: { amount: true }
            }),
            prisma.transaction.aggregate({
                where: { type: 'debit', status: 'success' },
                _sum: { amount: true }
            }),
            prisma.user.groupBy({
                by: ['status'],
                where: { role: 'customer' },
                _count: { _all: true }
            }),
            prisma.vendor.groupBy({
                by: ['status'],
                _count: { _all: true }
            }),
            prisma.withdrawal.count({ where: { status: 'pending' } }),
            prisma.qROrder.count({ where: { status: 'paid' } })
        ]);

        const userStatusCounts = userStatusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        const vendorStatusCounts = vendorStatusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        const totalCredit = Number(creditSum._sum.amount || 0);
        const totalDebit = Number(debitSum._sum.amount || 0);

        res.json({
            users: userCount,
            vendors: vendorCount,
            brands: brandCount,
            activeCampaigns,
            totalCampaigns,
            totalTransactions,
            totalQrs,
            redeemedQrs,
            totalWalletBalance: walletBalance._sum.balance || 0,
            totalCredit,
            totalDebit,
            platformRevenue: totalCredit - totalDebit,
            userStatusCounts,
            vendorStatusCounts,
            pendingWithdrawals: pendingWithdrawalsCount || 0,
            ordersAttention: ordersAttentionCount || 0
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching stats', error: error.message });
    }
};

// --- Finance & Revenue ---

exports.getFinanceSummary = async (req, res) => {
    try {
        const [
            rechargeAgg,
            ordersAgg,
            pendingWithdrawalAgg,
            processedWithdrawalAgg,
            rejectedWithdrawalAgg,
            walletFloatAgg,
            settlementTransactions
        ] = await Promise.all([
            prisma.transaction.aggregate({
                where: { category: 'recharge', status: 'success' },
                _sum: { amount: true },
                _count: { _all: true }
            }),
            prisma.qROrder.aggregate({
                _sum: { totalAmount: true },
                _count: { _all: true }
            }),
            prisma.withdrawal.aggregate({
                where: { status: 'pending' },
                _sum: { amount: true },
                _count: { _all: true }
            }),
            prisma.withdrawal.aggregate({
                where: { status: 'processed' },
                _sum: { amount: true },
                _count: { _all: true }
            }),
            prisma.withdrawal.aggregate({
                where: { status: 'rejected' },
                _sum: { amount: true },
                _count: { _all: true }
            }),
            prisma.wallet.aggregate({
                _sum: { balance: true }
            }),
            prisma.transaction.findMany({
                where: {
                    category: {
                        in: ['cashback_payout', 'withdrawal', 'campaign_payment', 'qr_purchase']
                    }
                },
                include: {
                    Wallet: {
                        include: {
                            Vendor: { include: { User: { select: { name: true, email: true } } } },
                            User: { select: { name: true, email: true } }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                take: 20
            })
        ]);

        const vendorRecharges = Number(rechargeAgg._sum.amount || 0);
        const techFeeEarnings = Number(ordersAgg._sum.totalAmount || 0);
        const payoutLiabilities = Number(pendingWithdrawalAgg._sum.amount || 0);
        const platformRevenue = techFeeEarnings;

        res.json({
            vendorRecharges,
            vendorRechargeCount: rechargeAgg._count._all || 0,
            techFeeEarnings,
            payoutLiabilities,
            platformRevenue,
            walletFloat: walletFloatAgg._sum.balance || 0,
            withdrawals: {
                pending: {
                    count: pendingWithdrawalAgg._count._all || 0,
                    amount: payoutLiabilities
                },
                processed: {
                    count: processedWithdrawalAgg._count._all || 0,
                    amount: Number(processedWithdrawalAgg._sum.amount || 0)
                },
                rejected: {
                    count: rejectedWithdrawalAgg._count._all || 0,
                    amount: Number(rejectedWithdrawalAgg._sum.amount || 0)
                }
            },
            settlements: settlementTransactions || []
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching finance summary', error: error.message });
    }
};

// --- User Management ---

exports.getAllUsers = async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const [users, total] = await Promise.all([
            prisma.user.findMany({
                where: { role: 'customer' },
                select: {
                    id: true,
                    name: true,
                    email: true,
                    username: true,
                    phoneNumber: true,
                    status: true,
                    createdAt: true,
                    updatedAt: true,
                    Wallet: {
                        select: {
                            id: true,
                            balance: true,
                            lockedBalance: true,
                            currency: true
                        }
                    }
                },
                skip,
                take: limit,
                orderBy: { createdAt: 'desc' }
            }),
            prisma.user.count({ where: { role: 'customer' } })
        ]);

        res.json({
            users,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching users', error: error.message });
    }
};

exports.updateUserStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // 'active' or 'blocked'

        if (!['active', 'inactive', 'blocked'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const user = await prisma.user.update({
            where: { id },
            data: { status }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            action: 'user_status_update',
            entityType: 'user',
            entityId: user.id,
            metadata: { status },
            req
        });
        res.json({ message: `User ${status}`, user });
    } catch (error) {
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

exports.deleteUser = async (req, res) => {
    try {
        const { id } = req.params;
        console.log(`[ADMIN] Deleting user account: ${id}`);

        // Perform soft delete by setting status to inactive
        // Also find and pause any associated vendor profile
        const user = await prisma.user.update({
            where: { id },
            data: { 
                status: 'inactive'
            }
        });

        // Try to update vendor status if it exists
        try {
            await prisma.vendor.updateMany({
                where: { userId: id },
                data: { status: 'paused' }
            });
        } catch (vErr) {
            console.error("Error pausing vendor during user deletion:", vErr);
        }

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            action: 'user_delete',
            entityType: 'user',
            entityId: id,
            metadata: { method: 'soft_delete' },
            req
        });

        res.json({ message: 'User account deactivated (soft deleted)', userId: id });
    } catch (error) {
        res.status(500).json({ message: 'Delete failed', error: error.message });
    }
};

exports.updateUserDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, email, username, phoneNumber, status } = req.body || {};

        const existingUser = await prisma.user.findUnique({
            where: { id },
            select: {
                id: true,
                role: true,
                email: true,
                username: true,
                phoneNumber: true,
                status: true
            }
        });

        if (!existingUser || existingUser.role !== 'customer') {
            return res.status(404).json({ message: 'Customer not found' });
        }

        const updates = {};
        if (name !== undefined) updates.name = String(name || '').trim() || null;
        if (email !== undefined) updates.email = String(email || '').trim().toLowerCase() || null;
        if (username !== undefined) updates.username = String(username || '').trim() || null;
        if (phoneNumber !== undefined) updates.phoneNumber = String(phoneNumber || '').trim() || null;
        if (status !== undefined) {
            if (!['active', 'inactive', 'blocked'].includes(status)) {
                return res.status(400).json({ message: 'Invalid status' });
            }
            updates.status = status;
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({ message: 'No user updates provided' });
        }

        if (updates.email) {
            const duplicateEmail = await prisma.user.findUnique({
                where: { email: updates.email },
                select: { id: true }
            });
            if (duplicateEmail && duplicateEmail.id !== id) {
                return res.status(409).json({ message: 'Email already in use' });
            }
        }

        if (updates.username) {
            const duplicateUsername = await prisma.user.findUnique({
                where: { username: updates.username },
                select: { id: true }
            });
            if (duplicateUsername && duplicateUsername.id !== id) {
                return res.status(409).json({ message: 'Username already in use' });
            }
        }

        if (updates.phoneNumber) {
            const duplicatePhone = await prisma.user.findUnique({
                where: { phoneNumber: updates.phoneNumber },
                select: { id: true }
            });
            if (duplicatePhone && duplicatePhone.id !== id) {
                return res.status(409).json({ message: 'Phone number already in use' });
            }
        }

        const user = await prisma.user.update({
            where: { id },
            data: updates,
            select: {
                id: true,
                role: true,
                name: true,
                email: true,
                username: true,
                phoneNumber: true,
                status: true,
                createdAt: true,
                updatedAt: true,
                Wallet: {
                    select: {
                        id: true,
                        balance: true,
                        lockedBalance: true,
                        currency: true
                    }
                }
            }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            action: 'user_details_update',
            entityType: 'user',
            entityId: user.id,
            metadata: {
                updatedFields: Object.keys(updates),
                status: updates.status
            },
            req
        });

        res.json({ message: 'User updated successfully', user });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update user', error: error.message });
    }
};

exports.getUserOverview = async (req, res) => {
    try {
        const { id } = req.params;

        const user = await prisma.user.findUnique({
            where: { id },
            select: {
                id: true,
                role: true,
                name: true,
                email: true,
                username: true,
                phoneNumber: true,
                status: true,
                avatarUrl: true,
                createdAt: true,
                updatedAt: true,
                Wallet: {
                    select: {
                        id: true,
                        balance: true,
                        lockedBalance: true,
                        currency: true,
                        updatedAt: true
                    }
                },
                PayoutMethods: {
                    select: {
                        id: true,
                        type: true,
                        value: true,
                        isPrimary: true,
                        createdAt: true
                    },
                    orderBy: { createdAt: 'desc' }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ message: 'Customer not found' });
        }
        if (user.role !== 'customer') {
            return res.status(400).json({ message: 'Overview is available for customer accounts only' });
        }

        const [transactions, redemptions, supportTickets, notifications] = await Promise.all([
            user.Wallet?.id
                ? prisma.transaction.findMany({
                    where: { walletId: user.Wallet.id },
                    orderBy: { createdAt: 'desc' },
                    take: 100
                })
                : Promise.resolve([]),
            prisma.qRCode.findMany({
                where: { redeemedByUserId: id, status: 'redeemed' },
                orderBy: { redeemedAt: 'desc' },
                take: 100,
                include: {
                    Campaign: {
                        select: {
                            id: true,
                            title: true,
                            Brand: {
                                select: { id: true, name: true }
                            }
                        }
                    }
                }
            }),
            prisma.supportTicket.findMany({
                where: { userId: id },
                orderBy: { createdAt: 'desc' },
                take: 100
            }),
            prisma.notification.findMany({
                where: { userId: id },
                orderBy: { createdAt: 'desc' },
                take: 100
            })
        ]);

        const metrics = {
            totalTransactions: transactions.length,
            credits: transactions.filter((tx) => tx.type === 'credit').length,
            debits: transactions.filter((tx) => tx.type === 'debit').length,
            totalCreditedAmount: transactions.reduce((sum, tx) => {
                return tx.type === 'credit' ? sum + Number(tx.amount || 0) : sum;
            }, 0),
            totalDebitedAmount: transactions.reduce((sum, tx) => {
                return tx.type === 'debit' ? sum + Number(tx.amount || 0) : sum;
            }, 0),
            totalRedemptions: redemptions.length,
            totalCashbackEarned: redemptions.reduce((sum, qr) => {
                return sum + Number(qr.cashbackAmount || 0);
            }, 0),
            totalSupportTickets: supportTickets.length,
            openSupportTickets: supportTickets.filter((t) => String(t.status || '').toLowerCase() === 'open').length,
            notifications: notifications.length,
            unreadNotifications: notifications.filter((n) => !n.isRead).length
        };

        res.json({
            user,
            metrics,
            transactions,
            redemptions,
            supportTickets,
            notifications
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch user overview', error: error.message });
    }
};

// --- Global Audit ---

exports.getAllTransactions = async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
        const { vendorId, brandId, walletId, userId, type, category, status, from, to } = req.query;
        const where = {};

        if (walletId) {
            where.walletId = walletId;
        }
        if (type) {
            where.type = type;
        }
        if (category) {
            where.category = category;
        }
        if (status) {
            where.status = status;
        }
        if (from || to) {
            where.createdAt = {};
            if (from) where.createdAt.gte = new Date(from);
            if (to) where.createdAt.lte = new Date(to);
        }

        let resolvedVendorId = vendorId;
        if (!resolvedVendorId && brandId) {
            const brand = await prisma.brand.findUnique({
                where: { id: brandId },
                select: { vendorId: true }
            });
            resolvedVendorId = brand?.vendorId || null;
        }

        if (brandId && !resolvedVendorId) {
            return res.json({
                transactions: [],
                pagination: {
                    total: 0,
                    page,
                    pages: 0
                }
            });
        }

        let walletFilter = null;
        if (userId) {
            walletFilter = { userId };
        } else if (resolvedVendorId) {
            walletFilter = { vendorId: resolvedVendorId };
        }

        if (walletFilter) {
            where.Wallet = walletFilter;
        }

        const [transactions, total] = await Promise.all([
            prisma.transaction.findMany({
                where,
                include: {
                    Wallet: {
                        include: {
                            User: { select: { name: true, email: true } },
                            Vendor: {
                                include: {
                                    User: { select: { name: true, email: true } }
                                }
                            }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.transaction.count({ where })
        ]);

        res.json({
            transactions,
            pagination: {
                total,
                page,
                pages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching transactions', error: error.message });
    }
};

exports.getAllQRs = async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req, { defaultLimit: 100, maxLimit: 500 });
        const { campaignId, vendorId, brandId, status, from, to, search, redeemedByUserId } = req.query;
        const where = {};
        const campaignWhere = {};

        if (campaignId) where.campaignId = campaignId;
        if (vendorId) where.vendorId = vendorId;
        if (status) where.status = status;
        if (redeemedByUserId) where.redeemedByUserId = redeemedByUserId;
        if (search) {
            where.uniqueHash = { contains: String(search), mode: 'insensitive' };
        }
        if (from || to) {
            where.createdAt = {};
            if (from) where.createdAt.gte = new Date(from);
            if (to) where.createdAt.lte = new Date(to);
        }
        if (brandId) {
            campaignWhere.brandId = brandId;
        }
        if (Object.keys(campaignWhere).length) {
            where.Campaign = campaignWhere;
        }

        const [qrs, total, statusGroups] = await Promise.all([
            prisma.qRCode.findMany({
                where,
                include: {
                    Campaign: {
                        select: {
                            title: true,
                            Brand: {
                                select: {
                                    name: true,
                                    Vendor: {
                                        select: {
                                            businessName: true,
                                            User: { select: { email: true } }
                                        }
                                    }
                                }
                            }
                        }
                    }
                },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.qRCode.count({ where }),
            prisma.qRCode.groupBy({
                by: ['status'],
                where,
                _count: { _all: true }
            })
        ]);

        const statusCounts = statusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        res.json({
            items: qrs,
            total,
            page,
            pages: total ? Math.ceil(total / limit) : 0,
            statusCounts
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching QRs', error: error.message });
    }
};

exports.getQrBatch = async (req, res) => {
    try {
        const { campaignId, cashbackAmount, limit, orderId } = req.query;

        const where = {};
        let take = Math.min(Number(limit) || 2000, 5000);

        if (orderId) {
            where.orderId = orderId;
        } else {
            // Batch mode: requires campaignId and cashbackAmount
            if (!campaignId) {
                return res.status(400).json({ message: 'campaignId is required (or orderId)' });
            }

            if (cashbackAmount === undefined || cashbackAmount === null || cashbackAmount === '') {
                return res.status(400).json({ message: 'cashbackAmount is required (or orderId)' });
            }

            const parsedCashback = Number(cashbackAmount);
            if (!Number.isFinite(parsedCashback)) {
                return res.status(400).json({ message: 'cashbackAmount must be a number' });
            }

            const normalizedCashback = Number(parsedCashback.toFixed(2));
            const cashbackFilter = normalizedCashback.toFixed(2);

            where.campaignId = campaignId;
            where.cashbackAmount = cashbackFilter;
        }

        const [qrs, total] = await Promise.all([
            prisma.qRCode.findMany({
                where,
                select: {
                    uniqueHash: true,
                    cashbackAmount: true,
                    status: true,
                    createdAt: true
                },
                orderBy: { createdAt: 'desc' },
                take
            }),
            prisma.qRCode.count({ where })
        ]);

        const formattedQrs = qrs.map(qr => ({
            ...qr,
            cashbackAmount: Number(qr.cashbackAmount)
        }));

        res.json({
            items: formattedQrs,
            total,
            limit: take
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching QR batch', error: error.message });
    }
};

// --- Advanced Admin Controls ---

exports.adjustWalletBalance = async (req, res) => {
    try {
        const { vendorId, amount, description, type } = req.body;
        const normalizedType = type === 'debit' ? 'debit' : 'credit';
        const parsedAmount = parseAmount(amount);

        if (!vendorId) {
            return res.status(400).json({ message: 'vendorId is required' });
        }
        if (!parsedAmount) {
            return res.status(400).json({ message: 'Valid amount is required' });
        }
        if (!description || !String(description).trim()) {
            return res.status(400).json({ message: 'Justification is required' });
        }

        const result = await prisma.$transaction(async (tx) => {
            const wallet = await tx.wallet.findUnique({ where: { vendorId } });
            if (!wallet) throw new Error('Wallet not found');

            if (normalizedType === 'debit' && Number(wallet.balance) < parsedAmount) {
                throw new Error('Insufficient wallet balance');
            }

            const updatedWallet = await tx.wallet.update({
                where: { id: wallet.id },
                data: {
                    balance:
                        normalizedType === 'debit'
                            ? { decrement: parsedAmount }
                            : { increment: parsedAmount }
                }
            });

            const transaction = await tx.transaction.create({
                data: {
                    walletId: wallet.id,
                    type: normalizedType,
                    amount: parsedAmount,
                    category: 'admin_adjustment',
                    status: 'success',
                    description: String(description).trim()
                }
            });

            return { wallet: updatedWallet, transaction };
        });

        const vendor = await prisma.vendor.findUnique({
            where: { id: vendorId },
            include: { Brand: true }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId,
            brandId: vendor?.Brand?.id,
            action: 'wallet_adjustment',
            entityType: 'wallet',
            entityId: result?.wallet?.id,
            metadata: {
                type: normalizedType,
                amount: parsedAmount,
                description: String(description).trim()
            },
            req
        });

        if (vendor?.userId) {
            await prisma.notification.create({
                data: {
                    userId: vendor.userId,
                    title: `Wallet ${normalizedType === 'debit' ? 'debited' : 'credited'}`,
                    message: `Admin ${normalizedType === 'debit' ? 'debited' : 'credited'} INR ${parsedAmount}. ${String(description).trim()}`,
                    type: 'wallet-adjustment',
                    metadata: { tab: 'wallet', amount: parsedAmount, type: normalizedType }
                }
            });
        }

        res.json({ message: 'Wallet adjusted successfully', data: result });
    } catch (error) {
        res.status(500).json({ message: 'Adjustment failed', error: error.message });
    }
};

exports.creditWallet = async (req, res) => {
    req.body.type = 'credit';
    return exports.adjustWalletBalance(req, res);
};

exports.updateCampaignStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body; // 'active', 'paused', 'rejected', 'completed'

        if (!['active', 'paused', 'rejected', 'completed'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' });
        }

        const campaign = await prisma.campaign.update({
            where: { id },
            data: { status }
        });

        const brand = await prisma.brand.findUnique({ where: { id: campaign.brandId } });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: brand?.vendorId,
            brandId: campaign.brandId,
            campaignId: campaign.id,
            action: 'campaign_status_update',
            entityType: 'campaign',
            entityId: campaign.id,
            metadata: { status },
            req
        });
        res.json({ message: `Campaign status updated to ${status}`, campaign });
    } catch (error) {
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

exports.getVendorDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const vendor = await prisma.vendor.findUnique({
            where: { id },
            include: {
                User: { select: { name: true, email: true, phoneNumber: true } },
                Wallet: true,
                Brand: { include: { Campaigns: true } }
            }
        });
        if (!vendor) return res.status(404).json({ message: 'Vendor not found' });
        res.json(vendor);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching details', error: error.message });
    }
};

// --- Payout Management ---

exports.getPendingWithdrawals = async (req, res) => {
    try {
        const withdrawals = await prisma.withdrawal.findMany({
            where: { status: 'pending' },
            include: {
                PayoutMethod: true,
                Wallet: {
                    include: {
                        User: { select: { name: true, email: true } },
                        Vendor: { select: { businessName: true, contactPhone: true } }
                    }
                }
            },
            orderBy: { createdAt: 'asc' }
        });
        res.json(withdrawals);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching withdrawals', error: error.message });
    }
};

// --- Support & Usage ---

exports.getAllSupportTickets = async (req, res) => {
    try {
        const tickets = await prisma.supportTicket.findMany({
            include: { User: { select: { name: true, email: true } } },
            orderBy: { createdAt: 'desc' }
        });
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching tickets', error: error.message });
    }
};

exports.replySupportTicket = async (req, res) => {
    try {
        const { id } = req.params;
        const { response, status } = req.body;

        const ticket = await prisma.supportTicket.update({
            where: { id },
            data: {
                response,
                status: status || 'resolved'
            }
        });
        res.json({ message: 'Ticket updated', ticket });
    } catch (error) {
        res.status(500).json({ message: 'Error updating ticket', error: error.message });
    }
};

exports.sendNotification = async (req, res) => {
    try {
        const { userId, title, message, type, metadata } = req.body;

        // If userId is 'all', send to all users (bulk create)
        if (userId === 'all') {
            const users = await prisma.user.findMany({ select: { id: true } });
            const notifications = users.map(user => ({
                userId: user.id,
                title,
                message,
                type: type || 'system',
                metadata
            }));
            await prisma.notification.createMany({ data: notifications });
            return res.json({ message: `Notification sent to ${users.length} users` });
        }

        const notification = await prisma.notification.create({
            data: {
                userId,
                title,
                message,
                type: type || 'system',
                metadata
            }
        });
        res.status(201).json({ message: 'Notification sent', notification });
    } catch (error) {
        res.status(500).json({ message: 'Error sending notification', error: error.message });
    }
};

exports.getNotifications = async (req, res) => {
    try {
        const userId = req.user?.id;
        if (!userId) {
            return res.status(401).json({ message: 'Unauthorized' });
        }

        const notifications = await prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 50
        });

        res.json(notifications);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching notifications', error: error.message });
    }
};

// --- QR Order Management ---

exports.getAllOrders = async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req, { defaultLimit: 20, maxLimit: 100 });
        const { vendorId, campaignId, status, brandId } = req.query;
        const where = {};

        if (vendorId) where.vendorId = vendorId;
        if (campaignId) where.campaignId = campaignId;
        if (status) where.status = status;

        if (brandId && !campaignId) {
            const campaigns = await prisma.campaign.findMany({
                where: { brandId },
                select: { id: true }
            });
            const campaignIds = campaigns.map(c => c.id);
            if (campaignIds.length) {
                where.campaignId = { in: campaignIds };
            } else {
                where.campaignId = { in: [''] };
            }
        }

        const [orders, total, statusGroups] = await Promise.all([
            prisma.qROrder.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit
            }),
            prisma.qROrder.count({ where }),
            prisma.qROrder.groupBy({
                by: ['status'],
                where,
                _count: { _all: true }
            })
        ]);

        const vendorIds = [...new Set(orders.map(o => o.vendorId))];
        const campaignIds = [...new Set(orders.map(o => o.campaignId))];

        const [vendors, campaigns] = await Promise.all([
            prisma.vendor.findMany({
                where: { id: { in: vendorIds } },
                include: {
                    User: { select: { email: true } },
                    Brand: { select: { name: true } }
                }
            }),
            prisma.campaign.findMany({
                where: { id: { in: campaignIds } },
                select: { id: true, title: true }
            })
        ]);

        const vendorMap = Object.fromEntries(vendors.map(v => [v.id, {
            businessName: v.businessName,
            brandName: v.Brand?.name,
            brandId: v.Brand?.id || null,
            email: v.User?.email
        }]));
        const campaignMap = Object.fromEntries(campaigns.map(c => [c.id, c.title]));

        const statusCounts = statusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        const formattedOrders = orders.map(order => ({
            id: order.id,
            vendorId: order.vendorId,
            vendor: vendorMap[order.vendorId] || { businessName: 'Unknown' },
            brandId: vendorMap[order.vendorId]?.brandId || null,
            campaignId: order.campaignId,
            campaignTitle: campaignMap[order.campaignId] || 'Unknown',
            quantity: order.quantity,
            cashbackAmount: Number(order.cashbackAmount),
            printCost: Number(order.printCost),
            totalAmount: Number(order.totalAmount),
            status: order.status,
            createdAt: order.createdAt
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

exports.updateOrderStatus = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['pending', 'paid', 'shipped'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status. Use: pending, paid, shipped' });
        }

        const order = await prisma.qROrder.findUnique({ where: { id } });
        if (!order) {
            return res.status(404).json({ message: 'Order not found' });
        }

        const updatedOrder = await prisma.qROrder.update({
            where: { id },
            data: { status }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: updatedOrder.vendorId,
            campaignId: updatedOrder.campaignId,
            action: 'order_status_update',
            entityType: 'order',
            entityId: updatedOrder.id,
            metadata: { status },
            req
        });

        res.json({
            message: `Order status updated to ${status}`,
            order: {
                id: updatedOrder.id,
                status: updatedOrder.status,
                quantity: updatedOrder.quantity
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

// --- Vendor/Brand Insights ---

exports.getVendorOverview = async (req, res) => {
    try {
        const { id } = req.params;
        const vendor = await prisma.vendor.findUnique({
            where: { id },
            include: {
                User: { select: { id: true, name: true, email: true, phoneNumber: true, username: true } },
                Wallet: true,
                Brand: true
            }
        });

        if (!vendor) return res.status(404).json({ message: 'Vendor not found' });

        const [campaigns, totalQrs, redeemedQrs, statusGroups, transactionCount] = await Promise.all([
            prisma.campaign.findMany({
                where: { Brand: { vendorId: vendor.id } },
                orderBy: { createdAt: 'desc' }
            }),
            prisma.qRCode.count({ where: { vendorId: vendor.id } }),
            prisma.qRCode.count({ where: { vendorId: vendor.id, status: 'redeemed' } }),
            prisma.qRCode.groupBy({
                by: ['status'],
                where: { vendorId: vendor.id },
                _count: { _all: true }
            }),
            vendor.Wallet
                ? prisma.transaction.count({ where: { walletId: vendor.Wallet.id } })
                : Promise.resolve(0),
        ]);

        const statusCounts = statusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        res.json({
            vendor,
            brand: vendor.Brand || null,
            wallet: vendor.Wallet || null,
            campaigns,
            metrics: {
                campaigns: campaigns.length,
                totalQrs,
                redeemedQrs,
                failedQrs: (statusCounts.expired || 0) + (statusCounts.blocked || 0),
                transactions: transactionCount,
                qrStatusCounts: statusCounts
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching vendor overview', error: error.message });
    }
};

exports.updateVendorDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const { businessName, contactPhone, alternatePhone, designation, contactEmail, gstin, address, city, state, pincode, techFeePerQr } = req.body;
        const data = {};

        if (businessName !== undefined) data.businessName = businessName;
        if (contactPhone !== undefined) data.contactPhone = contactPhone;
        if (alternatePhone !== undefined) data.alternatePhone = alternatePhone;
        if (designation !== undefined) data.designation = designation;
        if (contactEmail !== undefined) data.contactEmail = contactEmail;
        if (gstin !== undefined) data.gstin = gstin;
        if (address !== undefined) data.address = address;
        if (city !== undefined) data.city = city;
        if (state !== undefined) data.state = state;
        if (pincode !== undefined) data.pincode = pincode;
        if (techFeePerQr !== undefined) {
            const fee = parseFloat(techFeePerQr);
            if (!isNaN(fee) && fee >= 0) {
                data.techFeePerQr = fee;
            }
        }

        if (!Object.keys(data).length) {
            return res.status(400).json({ message: 'No vendor updates provided' });
        }

        const vendor = await prisma.vendor.update({
            where: { id },
            data
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: vendor.id,
            action: 'vendor_update',
            entityType: 'vendor',
            entityId: vendor.id,
            metadata: data,
            req
        });

        res.json({ message: 'Vendor updated', vendor });
    } catch (error) {
        res.status(500).json({ message: 'Error updating vendor', error: error.message });
    }
};

exports.updateVendorCredentials = async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password } = req.body;

        const vendor = await prisma.vendor.findUnique({
            where: { id },
            include: { User: true }
        });

        if (!vendor || !vendor.User) {
            return res.status(404).json({ message: 'Vendor not found' });
        }

        const userUpdates = {};

        if (username && username !== vendor.User.username) {
            const existing = await prisma.user.findUnique({ where: { username } });
            if (existing && existing.id !== vendor.User.id) {
                return res.status(400).json({ message: 'Username already taken' });
            }
            userUpdates.username = username;
        }

        if (password) {
            const hashed = await bcrypt.hash(password, 10);
            userUpdates.password = hashed;
        }

        if (!Object.keys(userUpdates).length) {
            return res.status(400).json({ message: 'No credential updates provided' });
        }

        const updatedUser = await prisma.user.update({
            where: { id: vendor.User.id },
            data: userUpdates
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: vendor.id,
            action: 'vendor_credentials_update',
            entityType: 'user',
            entityId: updatedUser.id,
            metadata: { username: updatedUser.username },
            req
        });

        res.json({ message: 'Vendor credentials updated', user: { id: updatedUser.id, username: updatedUser.username } });
    } catch (error) {
        res.status(500).json({ message: 'Failed to update credentials', error: error.message });
    }
};

exports.getVendorCredentialRequests = async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.query;
        const where = { vendorId: id };

        if (status) {
            where.status = status;
        }

        const requests = await prisma.credentialRequest.findMany({
            where,
            orderBy: { createdAt: 'desc' }
        });

        res.json(requests);
    } catch (error) {
        res.status(500).json({ message: 'Failed to fetch credential requests', error: error.message });
    }
};

exports.approveCredentialRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { username, password } = req.body || {};

        const request = await prisma.credentialRequest.findUnique({ where: { id } });
        if (!request) {
            return res.status(404).json({ message: 'Credential request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ message: 'Credential request already processed' });
        }

        const user = await prisma.user.findUnique({ where: { id: request.userId } });
        if (!user) {
            return res.status(404).json({ message: 'User not found for request' });
        }

        const updates = {};
        const trimmedUsername = typeof username === 'string' ? username.trim() : '';
        const desiredUsername = trimmedUsername || request.requestedUsername;

        if (desiredUsername && desiredUsername !== user.username) {
            const existing = await prisma.user.findUnique({ where: { username: desiredUsername } });
            if (existing && existing.id !== user.id) {
                return res.status(400).json({ message: 'Username already taken' });
            }
            updates.username = desiredUsername;
        }

        if (password) {
            updates.password = await bcrypt.hash(password, 10);
        } else if (request.requestedPassword) {
            updates.password = request.requestedPassword;
        }

        if (!Object.keys(updates).length) {
            return res.status(400).json({ message: 'No credential updates provided' });
        }

        const [updatedUser] = await prisma.$transaction([
            prisma.user.update({
                where: { id: user.id },
                data: updates
            }),
            prisma.credentialRequest.update({
                where: { id },
                data: { status: 'approved' }
            })
        ]);

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: request.vendorId,
            action: 'credential_request_approved',
            entityType: 'credential_request',
            entityId: request.id,
            metadata: { username: updatedUser.username },
            req
        });

        await prisma.notification.create({
            data: {
                userId: request.userId,
                title: 'Credentials updated',
                message: 'Your login credentials have been updated by admin.',
                type: 'credential-approved',
                metadata: { requestId: request.id }
            }
        });

        res.json({
            message: 'Credential request approved',
            user: { id: updatedUser.id, username: updatedUser.username }
        });
    } catch (error) {
        res.status(500).json({ message: 'Failed to approve credential request', error: error.message });
    }
};

exports.rejectCredentialRequest = async (req, res) => {
    try {
        const { id } = req.params;
        const { reason } = req.body || {};

        const request = await prisma.credentialRequest.findUnique({ where: { id } });
        if (!request) {
            return res.status(404).json({ message: 'Credential request not found' });
        }

        if (request.status !== 'pending') {
            return res.status(400).json({ message: 'Credential request already processed' });
        }

        const updatedRequest = await prisma.credentialRequest.update({
            where: { id },
            data: { status: 'rejected' }
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: request.vendorId,
            action: 'credential_request_rejected',
            entityType: 'credential_request',
            entityId: request.id,
            metadata: { reason: reason || null },
            req
        });

        await prisma.notification.create({
            data: {
                userId: request.userId,
                title: 'Credential request rejected',
                message: reason ? `Admin rejected your request: ${reason}` : 'Admin rejected your credential update request.',
                type: 'credential-rejected',
                metadata: { requestId: request.id }
            }
        });

        res.json({ message: 'Credential request rejected', request: updatedRequest });
    } catch (error) {
        res.status(500).json({ message: 'Failed to reject credential request', error: error.message });
    }
};

exports.getBrandOverview = async (req, res) => {
    try {
        const { id } = req.params;
        const brand = await prisma.brand.findUnique({
            where: { id },
            include: {
                Vendor: {
                    include: {
                        User: { select: { id: true, name: true, email: true, phoneNumber: true, username: true } },
                        Wallet: true
                    }
                },
                Campaigns: { orderBy: { createdAt: 'desc' } }
            }
        });

        if (!brand) return res.status(404).json({ message: 'Brand not found' });

        const [totalQrs, redeemedQrs, statusGroups] = await Promise.all([
            prisma.qRCode.count({ where: { Campaign: { brandId: brand.id } } }),
            prisma.qRCode.count({ where: { Campaign: { brandId: brand.id }, status: 'redeemed' } }),
            prisma.qRCode.groupBy({
                by: ['status'],
                where: { Campaign: { brandId: brand.id } },
                _count: { _all: true }
            })
        ]);

        const statusCounts = statusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        res.json({
            brand,
            vendor: brand.Vendor || null,
            campaigns: brand.Campaigns || [],
            metrics: {
                campaigns: brand.Campaigns?.length || 0,
                totalQrs,
                redeemedQrs,
                failedQrs: (statusCounts.expired || 0) + (statusCounts.blocked || 0),
                qrStatusCounts: statusCounts
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching brand overview', error: error.message });
    }
};

exports.updateBrandDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const { name, logoUrl, website, qrPricePerUnit, about, faqs } = req.body;
        const existingBrand = await prisma.brand.findUnique({
            where: { id },
            select: { id: true, vendorId: true, qrPricePerUnit: true }
        });
        if (!existingBrand) {
            return res.status(404).json({ message: 'Brand not found' });
        }
        const data = {};

        if (name !== undefined) data.name = name;
        if (logoUrl !== undefined) data.logoUrl = logoUrl;
        if (website !== undefined) data.website = website;
        if (about !== undefined) data.about = about;
        if (faqs !== undefined) data.faqs = faqs;
        const incomingPlanType =
            req.body.defaultPlanType !== undefined
                ? req.body.defaultPlanType
                : req.body.planType;

        if (incomingPlanType !== undefined) {
            const plan = incomingPlanType;
            if (['prepaid', 'postpaid'].includes(plan)) {
                data.defaultPlanType = plan;
            } else {
                return res.status(400).json({ message: 'Invalid plan type. Must be prepaid or postpaid' });
            }
        }
        if (qrPricePerUnit !== undefined && qrPricePerUnit !== '') {
            const normalizedQrPrice = parseQrPrice(qrPricePerUnit);
            if (normalizedQrPrice === null) {
                return res.status(400).json({ message: `QR price per unit must be between 0.01 and ${MAX_QR_PRICE}` });
            }
            data.qrPricePerUnit = normalizedQrPrice;
        }

        if (!Object.keys(data).length) {
            return res.status(400).json({ message: 'No brand updates provided' });
        }

        const previousQrPrice = existingBrand.qrPricePerUnit;
        const nextQrPrice = data.qrPricePerUnit;
        const qrPriceChanged =
            typeof nextQrPrice === 'number' && Number(previousQrPrice ?? null) !== Number(nextQrPrice);

        const brand = await prisma.brand.update({
            where: { id },
            data
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            brandId: brand.id,
            vendorId: brand.vendorId || existingBrand.vendorId || undefined,
            action: 'brand_update',
            entityType: 'brand',
            entityId: brand.id,
            metadata: data,
            req
        });
        if (qrPriceChanged) {
            safeLogActivity({
                actorUserId: req.user?.id,
                actorRole: req.user?.role,
                brandId: brand.id,
                vendorId: brand.vendorId || existingBrand.vendorId || undefined,
                action: 'brand_qr_price_update',
                entityType: 'brand',
                entityId: brand.id,
                metadata: { from: previousQrPrice, to: nextQrPrice },
                req
            });
        }

        // 
        if (data.defaultPlanType) {
            safeLogActivity({
                actorUserId: req.user?.id,
                actorRole: req.user?.role,
                brandId: brand.id,
                vendorId: brand.vendorId || existingBrand.vendorId || undefined,
                action: 'brand_plan_type_update',
                entityType: 'brand',
                entityId: brand.id,
                metadata: { planType: data.defaultPlanType },
                req
            });
        }

        res.json({ message: 'Brand updated', brand });
    } catch (error) {
        console.error('updateBrandDetails failed:', error);
        res.status(500).json({ message: 'Error updating brand' });
    }
};

exports.updateCampaignDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const {
            title,
            description,
            cashbackAmount,
            startDate,
            endDate,
            totalBudget,
            subtotal,
            allocations
        } = req.body;

        const data = {};
        if (title !== undefined) data.title = title;
        if (description !== undefined) data.description = description;
        if (cashbackAmount !== undefined) data.cashbackAmount = cashbackAmount;
        if (startDate) data.startDate = new Date(startDate);
        if (endDate) data.endDate = new Date(endDate);
        if (totalBudget !== undefined) data.totalBudget = totalBudget;
        if (subtotal !== undefined) data.subtotal = subtotal;
        if (allocations !== undefined) data.allocations = allocations;

        if (!Object.keys(data).length) {
            return res.status(400).json({ message: 'No campaign updates provided' });
        }

        const campaign = await prisma.campaign.update({
            where: { id },
            data
        });

        const brand = await prisma.brand.findUnique({ where: { id: campaign.brandId } });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            vendorId: brand?.vendorId,
            brandId: campaign.brandId,
            campaignId: campaign.id,
            action: 'campaign_update',
            entityType: 'campaign',
            entityId: campaign.id,
            metadata: data,
            req
        });

        res.json({ message: 'Campaign updated', campaign });
    } catch (error) {
        res.status(500).json({ message: 'Error updating campaign', error: error.message });
    }
};

exports.getCampaignAnalytics = async (req, res) => {
    try {
        const { id } = req.params;
        const campaign = await prisma.campaign.findUnique({
            where: { id },
            include: {
                Brand: {
                    include: {
                        Vendor: { select: { id: true, businessName: true, contactEmail: true } }
                    }
                }
            }
        });

        if (!campaign) return res.status(404).json({ message: 'Campaign not found' });

        const [totalQrs, redeemedQrs, statusGroups, orders, redeemerGroups, recentQrs, recentRedemptions] =
            await Promise.all([
                prisma.qRCode.count({ where: { campaignId: id } }),
                prisma.qRCode.count({ where: { campaignId: id, status: 'redeemed' } }),
                prisma.qRCode.groupBy({
                    by: ['status'],
                    where: { campaignId: id },
                    _count: { _all: true }
                }),
                prisma.qROrder.findMany({ where: { campaignId: id } }),
                prisma.qRCode.groupBy({
                    by: ['redeemedByUserId'],
                    where: { campaignId: id, redeemedByUserId: { not: null } },
                    _count: { _all: true }
                }),
                prisma.qRCode.findMany({
                    where: { campaignId: id },
                    select: { uniqueHash: true, status: true, createdAt: true, cashbackAmount: true },
                    orderBy: { createdAt: 'desc' },
                    take: 10
                }),
                prisma.qRCode.findMany({
                    where: { campaignId: id, status: 'redeemed' },
                    select: { uniqueHash: true, redeemedAt: true, redeemedByUserId: true, cashbackAmount: true },
                    orderBy: { redeemedAt: 'desc' },
                    take: 10
                })
            ]);

        const statusCounts = statusGroups.reduce((acc, row) => {
            const key = String(row.status || 'unknown').toLowerCase();
            acc[key] = row._count._all;
            return acc;
        }, {});

        const walletDeductionTotal = orders.reduce((sum, order) => {
            const cashback = Number(order.cashbackAmount) || 0;
            const printCost = Number(order.printCost) || 0;
            return sum + (cashback + printCost) * order.quantity;
        }, 0);

        const orderedQuantity = orders.reduce((sum, order) => sum + order.quantity, 0);
        const walletDeductionPerQr = orderedQuantity ? walletDeductionTotal / orderedQuantity : 0;

        const budgetTotal = campaign.totalBudget ? Number(campaign.totalBudget) : null;
        const budgetUsed = walletDeductionTotal;
        const budgetRemaining = budgetTotal !== null ? budgetTotal - budgetUsed : null;
        const budgetUsagePercent =
            budgetTotal !== null && budgetTotal > 0
                ? Number(((budgetUsed / budgetTotal) * 100).toFixed(2))
                : null;

        const topRedeemers = Array.isArray(redeemerGroups)
            ? [...redeemerGroups]
                .sort((a, b) => b._count._all - a._count._all)
                .slice(0, 5)
            : [];

        const now = new Date();
        const startDate = campaign.startDate ? new Date(campaign.startDate) : null;
        const endDate = campaign.endDate ? new Date(campaign.endDate) : null;
        const isWithinWindow = startDate && endDate ? now >= startDate && now <= endDate : null;
        const daysRemaining =
            endDate && endDate > now ? Math.ceil((endDate.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) : 0;

        res.json({
            campaign,
            vendor: campaign.Brand?.Vendor || null,
            metrics: {
                totalQrs,
                redeemedQrs,
                failedQrs: (statusCounts.expired || 0) + (statusCounts.blocked || 0),
                redemptionRate: totalQrs ? Number((redeemedQrs / totalQrs) * 100).toFixed(2) : '0.00',
                uniqueRedeemers: redeemerGroups.length,
                orders: orders.length,
                orderedQuantity,
                walletDeductionTotal,
                walletDeductionPerQr
            },
            statusCounts,
            budget: {
                total: budgetTotal,
                used: budgetUsed,
                remaining: budgetRemaining,
                usagePercent: budgetUsagePercent
            },
            topRedeemers,
            validity: {
                startDate,
                endDate,
                isWithinWindow,
                daysRemaining
            },
            recentQrs,
            recentRedemptions
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching campaign analytics', error: error.message });
    }
};

// --- C8: System Settings ---

exports.getSystemSettings = async (req, res) => {
    try {
        const defaultMetadata = {
            waitlistEnabled: false,
            fraudThresholds: {
                maxRedemptionsPerUser: 5,
                maxRedeemerSharePercent: 40
            },
            homeBanners: [],
            redeemStore: {
                products: []
            }
        };
        let settings = await prisma.systemSettings.findUnique({
            where: { id: 'default' }
        });

        // Create default settings if not exists
        if (!settings) {
            settings = await prisma.systemSettings.create({
                data: { id: 'default', metadata: defaultMetadata }
            });
        }

        const normalizedMetadata =
            settings?.metadata && typeof settings.metadata === 'object'
                ? { ...defaultMetadata, ...settings.metadata }
                : defaultMetadata;

        res.json({
            ...settings,
            metadata: normalizedMetadata,
            waitlistEnabled: normalizedMetadata.waitlistEnabled,
            fraudThresholds: normalizedMetadata.fraudThresholds
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching system settings', error: error.message });
    }
};

exports.updateSystemSettings = async (req, res) => {
    try {
        const {
            techFeePerQr,
            minPayoutAmount,
            maxDailyPayout,
            qrExpiryDays,
            platformName,
            supportEmail,
            termsUrl,
            privacyUrl,
            metadata,
            waitlistEnabled,
            fraudThresholds
        } = req.body;

        const data = {};
        if (techFeePerQr !== undefined) data.techFeePerQr = parseFloat(techFeePerQr);
        if (minPayoutAmount !== undefined) data.minPayoutAmount = parseFloat(minPayoutAmount);
        if (maxDailyPayout !== undefined) data.maxDailyPayout = parseFloat(maxDailyPayout);
        if (qrExpiryDays !== undefined) data.qrExpiryDays = parseInt(qrExpiryDays);
        if (platformName !== undefined) data.platformName = platformName;
        if (supportEmail !== undefined) data.supportEmail = supportEmail;
        if (termsUrl !== undefined) data.termsUrl = termsUrl;
        if (privacyUrl !== undefined) data.privacyUrl = privacyUrl;

        const metadataUpdates = {};
        if (metadata && typeof metadata === 'object') {
            Object.assign(metadataUpdates, metadata);
        }
        if (waitlistEnabled !== undefined) {
            metadataUpdates.waitlistEnabled = waitlistEnabled;
        }
        if (fraudThresholds !== undefined) {
            metadataUpdates.fraudThresholds = fraudThresholds;
        }

        if (Object.keys(metadataUpdates).length) {
            const existing = await prisma.systemSettings.findUnique({
                where: { id: 'default' }
            });
            const currentMetadata =
                existing?.metadata && typeof existing.metadata === 'object'
                    ? existing.metadata
                    : {};
            data.metadata = { ...currentMetadata, ...metadataUpdates };
        }

        if (!Object.keys(data).length) {
            return res.status(400).json({ message: 'No settings updates provided' });
        }

        const settings = await prisma.systemSettings.upsert({
            where: { id: 'default' },
            create: { id: 'default', ...data },
            update: data
        });

        safeLogActivity({
            actorUserId: req.user?.id,
            actorRole: req.user?.role,
            action: 'system_settings_update',
            entityType: 'system_settings',
            entityId: 'default',
            metadata: data,
            req
        });

        res.json({ message: 'System settings updated', settings });
    } catch (error) {
        res.status(500).json({ message: 'Error updating system settings', error: error.message });
    }
};

// --- C9: Activity Logs (Audit) ---

exports.getActivityLogs = async (req, res) => {
    try {
        const { page, limit, skip } = parsePagination(req, { defaultLimit: 50, maxLimit: 200 });
        const { action, actorRole, vendorId, brandId, campaignId, startDate, endDate } = req.query;

        const where = {};
        if (action) where.action = { contains: action, mode: 'insensitive' };
        if (actorRole) where.actorRole = actorRole;
        if (vendorId) where.vendorId = vendorId;
        if (brandId) where.brandId = brandId;
        if (campaignId) where.campaignId = campaignId;
        if (startDate || endDate) {
            where.createdAt = {};
            if (startDate) where.createdAt.gte = new Date(startDate);
            if (endDate) where.createdAt.lte = new Date(endDate);
        }

        const [logs, total] = await Promise.all([
            prisma.activityLog.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
                include: {
                    User: { select: { name: true, email: true, role: true } },
                    Vendor: { select: { businessName: true } },
                    Brand: { select: { name: true } },
                    Campaign: { select: { title: true } }
                }
            }),
            prisma.activityLog.count({ where })
        ]);

        // Get action summary for filters
        const actionGroups = await prisma.activityLog.groupBy({
            by: ['action'],
            _count: { _all: true },
            orderBy: { _count: { action: 'desc' } },
            take: 20
        });

        const actionCounts = actionGroups.reduce((acc, row) => {
            acc[row.action] = row._count._all;
            return acc;
        }, {});

        res.json({
            logs,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            },
            actionCounts
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching activity logs', error: error.message });
    }
};
