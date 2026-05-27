const prisma = require('../config/prismaClient');
const bcrypt = require('bcryptjs');
const { storeProducts } = require('../data/publicCatalog');

const toPositiveNumber = (value) => {
    const numeric = Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
};

const normalizeCatalogText = (value) => (typeof value === 'string' ? value.trim() : '');

const sanitizeRedeemStoreProduct = (product, index = 0) => {
    const name = normalizeCatalogText(product?.name);
    if (!name) return null;

    const statusRaw = normalizeCatalogText(product?.status).toLowerCase();
    const amountRaw = Number(product?.amount ?? product?.points);
    const stockRaw = Number(product?.stock);
    const id =
        normalizeCatalogText(product?.id) ||
        normalizeCatalogText(product?.sku) ||
        `redeem-product-${index + 1}`;

    return {
        id,
        name,
        amount: Number.isFinite(amountRaw) && amountRaw > 0 ? amountRaw : 0,
        stock: Number.isFinite(stockRaw) ? Math.max(0, Math.floor(stockRaw)) : null,
        status: statusRaw === 'inactive' ? 'inactive' : 'active'
    };
};

const formatCashbackValue = (value) => {
    if (!Number.isFinite(value)) return null;
    return Number.isInteger(value) ? `${value}` : value.toFixed(2);
};

const getCampaignCashbackRange = (campaign, productId) => {
    if (!campaign) return null;
    const amounts = [];

    const base = toPositiveNumber(campaign.cashbackAmount);
    if (base) amounts.push(base);

    const allocations = Array.isArray(campaign.allocations) ? campaign.allocations : [];
    allocations.forEach((alloc) => {
        if (productId && alloc?.productId && alloc.productId !== productId) return;
        const amount = toPositiveNumber(alloc?.cashbackAmount);
        if (amount) amounts.push(amount);
    });

    if (!amounts.length) return null;
    const min = Math.min(...amounts);
    const max = Math.max(...amounts);
    return { min, max };
};

const getCampaignRewardLabel = (campaign, productId) => {
    const range = getCampaignCashbackRange(campaign, productId);
    if (!range) return 'Check App';
    const minLabel = formatCashbackValue(range.min);
    const maxLabel = formatCashbackValue(range.max);
    if (!minLabel || !maxLabel) return 'Check App';
    if (range.min === range.max) return `Up to INR ${maxLabel}`;
    return `Up to INR ${minLabel} - ${maxLabel}`;
};

exports.getDashboard = async (req, res) => {
    try {
        const userId = req.user.id;

        // Fetch User with Wallet and recent Transactions
        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: {
                Wallet: {
                    include: {
                        Transactions: {
                            take: 10,
                            orderBy: { createdAt: 'desc' }
                        }
                    }
                }
            }
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        // Handle case where wallet might not exist yet
        const wallet = user.Wallet || { balance: '0.00', Transactions: [] };

        res.json({
            user: {
                id: user.id,
                name: user.name,
                email: user.email,
                phoneNumber: user.phoneNumber,
                role: user.role,
                avatarUrl: user.avatarUrl
            },
            wallet: {
                balance: wallet.balance,
                currency: 'INR'
            },
            recentTransactions: wallet.Transactions || []
        });

    } catch (error) {
        console.error(error);
        res.status(500).json({ message: 'Server Error', error: error.message });
    }
};

// requestPayout is deprecated and replaced by paymentController.requestWithdrawal
// routed via /api/user/payout -> requestWithdrawal

exports.getRedemptionHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const redemptions = await prisma.qRCode.findMany({
            where: { redeemedByUserId: userId, status: 'redeemed' },
            include: { Campaign: { include: { Brand: true } } },
            orderBy: { redeemedAt: 'desc' }
        });
        res.json(redemptions);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching redemptions', error: error.message });
    }
};

exports.getTransactionHistory = async (req, res) => {
    try {
        const userId = req.user.id;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const skip = (page - 1) * limit;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { Wallet: true }
        });

        if (!user || !user.Wallet) return res.json({ transactions: [], count: 0 });

        const [transactions, count] = await Promise.all([
            prisma.transaction.findMany({
                where: { walletId: user.Wallet.id },
                orderBy: { createdAt: 'desc' },
                skip: skip,
                take: limit
            }),
            prisma.transaction.count({ where: { walletId: user.Wallet.id } })
        ]);

        res.json({
            transactions,
            pagination: {
                total: count,
                page: page,
                pages: Math.ceil(count / limit)
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching transactions', error: error.message });
    }
};

exports.updateUserProfile = async (req, res) => {
    try {
        const { name, email, username, phoneNumber, dob } = req.body || {};

        const updates = {};
        if (typeof name === 'string') updates.name = name.trim() || null;
        if (typeof email === 'string') updates.email = email.trim().toLowerCase() || null;
        if (typeof username === 'string') updates.username = username.trim() || null;
        if (typeof phoneNumber === 'string') updates.phoneNumber = phoneNumber.trim() || null;
        if (typeof dob === 'string') updates.dob = dob.trim() || null;

        if (!Object.keys(updates).length) {
            return res.status(400).json({ message: 'No profile updates provided' });
        }

        if (updates.email) {
            const existing = await prisma.user.findUnique({ where: { email: updates.email } });
            if (existing && existing.id !== req.user.id) {
                return res.status(400).json({ message: 'Email already in use' });
            }
        }

        if (updates.username) {
            const existing = await prisma.user.findUnique({ where: { username: updates.username } });
            if (existing && existing.id !== req.user.id) {
                return res.status(400).json({ message: 'Username already in use' });
            }
        }

        if (updates.phoneNumber) {
            const existing = await prisma.user.findUnique({ where: { phoneNumber: updates.phoneNumber } });
            if (existing && existing.id !== req.user.id) {
                return res.status(400).json({ message: 'Phone number already in use' });
            }
        }

        const user = await prisma.user.update({
            where: { id: req.user.id },
            data: updates
        });

        const { password, otp, otpExpires, resetPasswordToken, resetPasswordExpires, ...safeUser } = user;
        res.json({ message: 'Profile updated', user: safeUser });
    } catch (error) {
        res.status(500).json({ message: 'Update failed', error: error.message });
    }
};

exports.uploadAvatar = async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ message: 'No file uploaded' });
        }

        const avatarUrl = `/uploads/${req.file.filename}`;

        const user = await prisma.user.update({
            where: { id: req.user.id },
            data: { avatarUrl }
        });

        res.json({ message: 'Avatar updated', avatarUrl, user });
    } catch (error) {
        res.status(500).json({ message: 'Avatar upload failed', error: error.message });
    }
};

exports.changePassword = async (req, res) => {
    try {
        const { oldPassword, newPassword } = req.body;
        const userId = req.user.id;

        const user = await prisma.user.findUnique({ where: { id: userId } });

        if (!user || !(await bcrypt.compare(oldPassword, user.password))) {
            return res.status(400).json({ message: 'Invalid old password' });
        }

        const salt = await bcrypt.genSalt(10);
        const hashedPassword = await bcrypt.hash(newPassword, salt);

        await prisma.user.update({
            where: { id: userId },
            data: { password: hashedPassword }
        });

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error changing password', error: error.message });
    }
};

exports.deleteAccount = async (req, res) => {
    try {
        const userId = req.user.id;

        // Soft delete: changing status to inactive/blocked
        // We might also want to clear sensitive info? 
        // For now, just disabling access.

        await prisma.user.update({
            where: { id: userId },
            data: { status: 'inactive' } // or 'blocked', schema has 'inactive'
        });

        res.json({ message: 'Account deactivated successfully' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting account', error: error.message });
    }
};

// --- New "More Flow" Features ---

exports.getAvailableOffers = async (req, res) => {
    try {
        const { search, brandId } = req.query;

        let whereClause = {
            status: 'active',
            endDate: { gt: new Date() }
        };

        if (brandId) {
            whereClause.brandId = brandId;
        }

        if (search) {
            whereClause.OR = [
                { title: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } }
            ];
        }

        const offers = await prisma.campaign.findMany({
            where: whereClause,
            include: { Brand: true },
            orderBy: { endDate: 'asc' }
        });
        res.json(offers);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching offers', error: error.message });
    }
};

exports.getOfferDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const offer = await prisma.campaign.findUnique({
            where: { id },
            include: { Brand: true }
        });
        if (!offer) return res.status(404).json({ message: 'Offer not found' });
        res.json(offer);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching offer details', error: error.message });
    }
};

exports.getActiveBrands = async (req, res) => {
    try {
        const brands = await prisma.brand.findMany({
            where: {
                status: 'active'
            },
            select: { id: true, name: true, logoUrl: true, website: true }
        });
        res.json(brands);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching brands', error: error.message });
    }
};

exports.createSupportTicket = async (req, res) => {
    try {
        const subject = typeof req.body?.subject === 'string' ? req.body.subject.trim() : '';
        const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';

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

        const isProductReport = /^product report(?:\b|:|-)/i.test(subject);
        if (isProductReport) {
            const extractContextValue = (label) => {
                const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const matcher = new RegExp(`^${escapedLabel}\\s*:\\s*(.+)$`, 'im');
                const match = String(message || '').match(matcher);
                return match ? String(match[1] || '').trim() : '';
            };

            const productId = extractContextValue('Product ID');
            const brandId = extractContextValue('Brand ID');

            let vendorId = null;
            if (brandId) {
                const brand = await prisma.brand.findUnique({
                    where: { id: brandId },
                    select: { vendorId: true }
                });
                vendorId = brand?.vendorId || null;
            }

            if (!vendorId && productId) {
                const product = await prisma.product.findUnique({
                    where: { id: productId },
                    select: {
                        Brand: {
                            select: { vendorId: true }
                        }
                    }
                });
                vendorId = product?.Brand?.vendorId || null;
            }

            if (vendorId) {
                await prisma.productReport.create({
                    data: {
                        vendorId,
                        productId: productId || null,
                        userId: req.user.id,
                        title: subject,
                        description: message,
                        fileName: `product-report-${ticket.id}.txt`
                    }
                });
            }
        }

        const admins = await prisma.user.findMany({
            where: { role: 'admin', status: 'active' },
            select: { id: true }
        });

        if (admins.length) {
            const reporterLabel = req.user?.name || req.user?.email || `User ${String(req.user?.id || '').slice(0, 8)}`;
            const notifications = admins.map((admin) => ({
                userId: admin.id,
                title: isProductReport ? 'New Product Report' : 'New Support Ticket',
                message: `${reporterLabel} submitted: ${subject}`,
                type: 'support_ticket',
                metadata: {
                    tab: 'support',
                    ticketId: ticket.id,
                    reporterUserId: req.user.id
                }
            }));

            await prisma.notification.createMany({
                data: notifications
            });
        }

        res.status(201).json({ message: 'Support ticket created', ticket });
    } catch (error) {
        res.status(500).json({ message: 'Ticket creation failed', error: error.message });
    }
};

exports.getSupportTickets = async (req, res) => {
    try {
        const tickets = await prisma.supportTicket.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' }
        });
        res.json(tickets);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching tickets', error: error.message });
    }
};

exports.getNotifications = async (req, res) => {
    try {
        const notifications = await prisma.notification.findMany({
            where: { userId: req.user.id },
            orderBy: { createdAt: 'desc' }
        });
        res.json(notifications);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching notifications', error: error.message });
    }
};

exports.markNotificationRead = async (req, res) => {
    try {
        const { id } = req.params;
        await prisma.notification.update({
            where: { id },
            data: { isRead: true }
        });
        res.json({ message: 'Notification marked as read' });
    } catch (error) {
        res.status(500).json({ message: 'Error updating notification', error: error.message });
    }
};

// --- Catalog & Home API ---

exports.getHomeData = async (req, res) => {
    try {
        const settings = await prisma.systemSettings.findUnique({
            where: { id: 'default' },
            select: { metadata: true }
        });
        const rawBanners = settings?.metadata?.homeBanners;
        const banners = Array.isArray(rawBanners)
            ? rawBanners
                .map((banner, index) => ({
                    id: banner?.id || banner?.key || banner?.slug || index + 1,
                    title: banner?.title || banner?.heading || '',
                    subtitle: banner?.subtitle || banner?.subTitle || banner?.caption || '',
                    img: banner?.img || banner?.imageUrl || banner?.image || banner?.bannerImage || '',
                    accent: banner?.accent || banner?.gradient || '',
                    link: banner?.link || banner?.ctaLink || ''
                }))
                .filter((banner) => banner.title || banner.subtitle || banner.img)
            : [];

        const brands = await prisma.brand.findMany({
            where: { status: 'active' },
            take: 6,
            select: { id: true, name: true, logoUrl: true }
        });

        // Featured Products (Latest 4)
        const featuredProducts = await prisma.product.findMany({
            where: { status: 'active' },
            take: 4,
            orderBy: { createdAt: 'desc' },
            include: { Brand: true }
        });

        res.json({
            banners,
            brands,
            featuredProducts,
            stats: {
                productsOwned: 0, // Placeholder
                productsReported: 0 // Placeholder
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Error loading home data', error: error.message });
    }
};

exports.getCatalog = async (req, res) => {
    try {
        const { search, brandId, category } = req.query;
        let whereClause = { status: 'active' };

        if (search) {
            whereClause.OR = [
                { name: { contains: search, mode: 'insensitive' } },
                { description: { contains: search, mode: 'insensitive' } }
            ];
        }
        if (brandId) whereClause.brandId = brandId;
        if (category) whereClause.category = category;

        const products = await prisma.product.findMany({
            where: whereClause,
            include: { Brand: true }
        });
        res.json(products);
    } catch (error) {
        res.status(500).json({ message: 'Error fetching catalog', error: error.message });
    }
};

exports.getProductDetails = async (req, res) => {
    try {
        const { id } = req.params;
        const product = await prisma.product.findUnique({
            where: { id },
            include: { Brand: true }
        });

        if (!product) return res.status(404).json({ message: 'Product not found' });

        // Heuristic: Find active campaign for this brand to show available reward
        const activeCampaign = await prisma.campaign.findFirst({
            where: { brandId: product.brandId, status: 'active' },
            orderBy: { cashbackAmount: 'desc' }
        });

        res.json({
            ...product,
            reward: getCampaignRewardLabel(activeCampaign, product.id),
            scheme: activeCampaign ? activeCampaign.title : 'Standard Offer'
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching product', error: error.message });
    }
};

exports.getHomeStats = async (req, res) => {
    try {
        const userId = req.user.id;

        const user = await prisma.user.findUnique({
            where: { id: userId },
            include: { Wallet: true }
        });

        if (!user) return res.status(404).json({ message: 'User not found' });

        const [productsOwned, productsReported, totalEarnedResult, ordersCount] = await Promise.all([
            prisma.qRCode.count({
                where: { redeemedByUserId: userId, status: 'redeemed' }
            }),
            prisma.supportTicket.count({
                where: { userId }
            }),
            user.Wallet ? prisma.transaction.aggregate({
                where: {
                    walletId: user.Wallet.id,
                    type: 'credit'
                },
                _sum: { amount: true }
            }) : Promise.resolve({ _sum: { amount: 0 } }),
            user.Wallet ? prisma.transaction.count({
                where: {
                    walletId: user.Wallet.id,
                    type: 'debit',
                    description: { contains: 'Store redeem', mode: 'insensitive' }
                }
            }) : Promise.resolve(0)
        ]);

        res.json({
            productsOwned,
            productsReported,
            balance: user.Wallet ? Number(user.Wallet.balance) : 0,
            totalEarned: totalEarnedResult._sum.amount || 0,
            ordersCount
        });
    } catch (error) {
        res.status(500).json({ message: 'Error fetching home stats', error: error.message });
    }
};

exports.redeemStoreProduct = async (req, res) => {
    try {
        const userId = req.user.id;
        const productId = normalizeCatalogText(req.body?.productId);

        if (!productId) {
            return res.status(400).json({ message: 'Product ID is required' });
        }

        const settings = await prisma.systemSettings.findUnique({
            where: { id: 'default' },
            select: { metadata: true }
        });

        const metadata =
            settings?.metadata && typeof settings.metadata === 'object'
                ? settings.metadata
                : {};
        const redeemStore =
            metadata?.redeemStore && typeof metadata.redeemStore === 'object'
                ? metadata.redeemStore
                : {};
        const configuredProducts = Array.isArray(redeemStore.products)
            ? redeemStore.products
            : [];
        const products = configuredProducts.length ? configuredProducts : storeProducts;
        const normalizedProducts = products
            .map((item, index) => sanitizeRedeemStoreProduct(item, index))
            .filter(Boolean);

        const selectedProduct = normalizedProducts.find(
            (item) => String(item.id).toLowerCase() === productId.toLowerCase()
        );

        if (!selectedProduct || selectedProduct.status !== 'active') {
            return res.status(404).json({ message: 'Product not available for redeem' });
        }

        if (!Number.isFinite(selectedProduct.amount) || selectedProduct.amount <= 0) {
            return res.status(400).json({ message: 'Product amount is invalid' });
        }

        if (Number.isFinite(selectedProduct.stock) && selectedProduct.stock <= 0) {
            return res.status(400).json({ message: 'Product is out of stock' });
        }

        let walletAfterRedeem = null;

        await prisma.$transaction(async (tx) => {
            // Fetch settings inside transaction to ensure we update the latest stock
            const settings = await tx.systemSettings.findUnique({
                where: { id: 'default' },
                select: { metadata: true }
            });

            const metadata = settings?.metadata && typeof settings.metadata === 'object'
                ? settings.metadata
                : {};
            const redeemStore = metadata?.redeemStore && typeof metadata.redeemStore === 'object'
                ? metadata.redeemStore
                : {};
            const productsInMeta = Array.isArray(redeemStore.products)
                ? redeemStore.products
                : [];

            // Find and update stock in metadata if applicable
            const productIndex = productsInMeta.findIndex(
                (p) => String(p.id || p.sku).toLowerCase() === productId.toLowerCase()
            );

            if (productIndex !== -1) {
                const p = productsInMeta[productIndex];
                const currentStock = Number(p.stock);
                if (Number.isFinite(currentStock)) {
                    if (currentStock <= 0) {
                        const outOfStock = new Error('Product is out of stock');
                        outOfStock.code = 'OUT_OF_STOCK';
                        throw outOfStock;
                    }
                    // Decrement stock in the array
                    p.stock = currentStock - 1;
                    
                    // Save updated metadata
                    await tx.systemSettings.update({
                        where: { id: 'default' },
                        data: { metadata: metadata }
                    });
                }
            }

            let wallet = await tx.wallet.findUnique({ where: { userId } });
            if (!wallet) {
                wallet = await tx.wallet.create({
                    data: {
                        userId,
                        balance: 0.0,
                        currency: 'INR'
                    }
                });
            }

            const currentBalance = Number(wallet.balance);
            if (!Number.isFinite(currentBalance) || currentBalance < selectedProduct.amount) {
                const insufficient = new Error('Insufficient wallet balance');
                insufficient.code = 'INSUFFICIENT_BALANCE';
                throw insufficient;
            }

            walletAfterRedeem = await tx.wallet.update({
                where: { id: wallet.id },
                data: {
                    balance: { decrement: selectedProduct.amount }
                }
            });

            await tx.transaction.create({
                data: {
                    walletId: wallet.id,
                    type: 'debit',
                    amount: selectedProduct.amount,
                    category: 'withdrawal',
                    status: 'success',
                    referenceId: selectedProduct.id,
                    description: `Store redeem: ${selectedProduct.name}`,
                    metadata: {
                        address: req.body?.address || ""
                    }
                }
            });

            await tx.notification.create({
                data: {
                    userId,
                    title: 'Redeem successful',
                    message: `${selectedProduct.name} redeemed for INR ${selectedProduct.amount.toFixed(2)}.`,
                    type: 'store-redeem',
                    metadata: {
                        tab: 'store',
                        productId: selectedProduct.id,
                        amount: selectedProduct.amount,
                        address: req.body?.address || ""
                    }
                }
            });
        });

        return res.status(201).json({
            success: true,
            message: 'Product redeemed successfully',
            redeem: {
                productId: selectedProduct.id,
                name: selectedProduct.name,
                amount: selectedProduct.amount
            },
            wallet: {
                balance: Number(walletAfterRedeem?.balance || 0),
                currency: walletAfterRedeem?.currency || 'INR'
            }
        });
    } catch (error) {
        if (error?.code === 'INSUFFICIENT_BALANCE') {
            return res.status(400).json({ message: 'Insufficient wallet balance' });
        }
        res.status(500).json({ message: 'Failed to redeem product', error: error.message });
    }
};

