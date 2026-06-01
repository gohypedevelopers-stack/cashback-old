const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const prisma = require('../config/prismaClient');
const { allocateInventoryQrs } = require('./qrInventoryService');
const { generateQrPdfToFile } = require('../utils/qrPdfGenerator');
const { resolvePostpaidSheetSize } = require('../utils/postpaidSheet');

const BULK_EXPORT_STATUS = {
    QUEUED: 'queued',
    PROCESSING: 'processing',
    COMPLETED: 'completed',
    FAILED: 'failed'
};

const BULK_EXPORT_TYPE = {
    CAMPAIGN_QR_PDF: 'campaign_qr_pdf',
    INVENTORY_QR_PDF: 'inventory_qr_pdf',
    CAMPAIGN_ACTIVATION: 'campaign_activation'
};

const POSTPAID_SHEET_QR_STATUSES = ['funded', 'generated', 'active', 'assigned', 'redeemed'];
const BULK_EXPORT_ROOT_DIR = path.resolve(__dirname, '../../generated-exports');
const BULK_EXPORT_WORKER_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.BULK_QR_EXPORT_WORKER_INTERVAL_MS || '4000', 10);
    if (!Number.isFinite(parsed) || parsed < 1000) return 4000;
    return parsed;
})();
const BULK_EXPORT_MAX_QRS_PER_PART = (() => {
    const parsed = Number.parseInt(process.env.BULK_QR_EXPORT_MAX_QRS_PER_PART || '50000', 10);
    if (!Number.isFinite(parsed) || parsed < 1000) return 50000;
    return parsed;
})();
const BULK_EXPORT_PROGRESS_STEP = (() => {
    const parsed = Number.parseInt(process.env.BULK_QR_EXPORT_PROGRESS_STEP || '250', 10);
    if (!Number.isFinite(parsed) || parsed < 25) return 250;
    return parsed;
})();
const BULK_EXPORT_PROGRESS_MIN_INTERVAL_MS = (() => {
    const parsed = Number.parseInt(process.env.BULK_QR_EXPORT_PROGRESS_MIN_INTERVAL_MS || '1500', 10);
    if (!Number.isFinite(parsed) || parsed < 250) return 1500;
    return parsed;
})();
const BULK_EXPORT_EXPIRY_HOURS = (() => {
    const parsed = Number.parseInt(process.env.BULK_QR_EXPORT_EXPIRY_HOURS || '72', 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 72;
    return parsed;
})();
const CAMPAIGN_ACTIVATION_TX_TIMEOUT_MS = Number.isFinite(Number(process.env.VENDOR_LARGE_TX_TIMEOUT_MS))
    ? Number(process.env.VENDOR_LARGE_TX_TIMEOUT_MS)
    : 900000;
const CAMPAIGN_ACTIVATION_TX_MAX_WAIT_MS = Number.isFinite(Number(process.env.VENDOR_TX_MAX_WAIT_MS))
    ? Number(process.env.VENDOR_TX_MAX_WAIT_MS)
    : 10000;
const BULK_EXPORT_CANCELLED_CODE = 'BULK_EXPORT_CANCELLED';
const BULK_EXPORT_CANCELLED_MESSAGE = 'Cancelled by user.';

let workerInterval = null;
let workerBusy = false;

const ensureExportRootDir = () => {
    fs.mkdirSync(BULK_EXPORT_ROOT_DIR, { recursive: true });
};

const isMissingBulkExportTableError = (error) => {
    if (!error) return false;
    const message = String(error.message || '');
    return (
        error.code === 'P2021' ||
        error.code === 'P2022' ||
        message.includes('BulkExportJob') && message.includes('does not exist in the current database')
    );
};

const buildBulkExportUnavailableError = () => {
    const error = new Error('Background QR processing is temporarily unavailable until database migrations are applied.');
    error.status = 503;
    error.code = 'BULK_EXPORT_UNAVAILABLE';
    return error;
};

const toPositiveInt = (value, fallback = null) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
};

const sanitizeStem = (value, fallback) => {
    const cleaned = String(value || '')
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1F]+/g, '-')
        .replace(/\s+/g, ' ')
        .replace(/\.+$/g, '')
        .trim();
    return (cleaned || fallback).slice(0, 120);
};

const clampProgress = (processedQrs, totalQrs) => {
    const safeTotal = Math.max(0, Number.parseInt(totalQrs, 10) || 0);
    const safeProcessed = Math.max(0, Number.parseInt(processedQrs, 10) || 0);
    if (!safeTotal) return 0;
    return Math.min(safeTotal, safeProcessed);
};

const buildExpiryDate = () => {
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + BULK_EXPORT_EXPIRY_HOURS);
    return expiresAt;
};

const getJobDirectory = (jobId) => path.join(BULK_EXPORT_ROOT_DIR, jobId);
const getJobDownloadPath = (jobId) => `/api/vendor/qr-export/jobs/${jobId}/download`;

const createVendorNotification = async ({ vendorId, title, message, type, metadata }) => {
    if (!vendorId) return null;

    const vendor = await prisma.vendor.findUnique({
        where: { id: vendorId },
        select: { userId: true }
    });
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

const safeCreateVendorNotification = async (payload) => {
    try {
        await createVendorNotification(payload);
    } catch (error) {
        console.error('[BulkExport] Notification error:', error.message);
    }
};

const buildCancelledJobError = () => {
    const error = new Error(BULK_EXPORT_CANCELLED_MESSAGE);
    error.code = BULK_EXPORT_CANCELLED_CODE;
    error.status = 409;
    return error;
};

const isCancelledJobError = (error) => {
    if (!error) return false;
    if (error.code === BULK_EXPORT_CANCELLED_CODE) return true;
    const message = String(error.message || '').toLowerCase();
    return message.includes('cancelled by user');
};

const updateProcessingJobOrThrow = async (jobId, data) => {
    const result = await prisma.bulkExportJob.updateMany({
        where: {
            id: jobId,
            status: BULK_EXPORT_STATUS.PROCESSING
        },
        data
    });

    if (!result.count) {
        throw buildCancelledJobError();
    }
};

const assertJobProcessingOrThrow = async (jobId) => {
    const job = await prisma.bulkExportJob.findUnique({
        where: { id: jobId },
        select: { status: true }
    });

    if (!job || job.status !== BULK_EXPORT_STATUS.PROCESSING) {
        throw buildCancelledJobError();
    }
};

const buildProgressUpdater = (jobId, totalQrs, processedBeforePart = 0) => {
    let lastPersisted = clampProgress(processedBeforePart, totalQrs);
    let lastPersistAt = 0;

    return async (partProcessedQrs) => {
        const nextProcessed = clampProgress(processedBeforePart + partProcessedQrs, totalQrs);
        const now = Date.now();
        const shouldPersist =
            nextProcessed >= totalQrs ||
            nextProcessed - lastPersisted >= BULK_EXPORT_PROGRESS_STEP ||
            now - lastPersistAt >= BULK_EXPORT_PROGRESS_MIN_INTERVAL_MS;

        if (!shouldPersist || nextProcessed === lastPersisted) {
            return;
        }

        lastPersisted = nextProcessed;
        lastPersistAt = now;

        await updateProcessingJobOrThrow(jobId, { processedQrs: nextProcessed });
    };
};

const calculatePartPlan = ({ totalQrs, qrsPerSheet = null, splitParts = true }) => {
    const safeTotalQrs = Math.max(0, Number.parseInt(totalQrs, 10) || 0);
    if (!safeTotalQrs) {
        return {
            partCount: 0,
            qrsPerPart: 0
        };
    }

    if (!splitParts && safeTotalQrs <= BULK_EXPORT_MAX_QRS_PER_PART) {
        return {
            partCount: 1,
            qrsPerPart: safeTotalQrs
        };
    }

    if (Number.isFinite(Number(qrsPerSheet)) && Number(qrsPerSheet) > 0) {
        const safeSheetSize = Number(qrsPerSheet);
        const sheetsPerPart = Math.max(1, Math.floor(BULK_EXPORT_MAX_QRS_PER_PART / safeSheetSize));
        const qrsPerPart = sheetsPerPart * safeSheetSize;
        return {
            partCount: Math.max(1, Math.ceil(safeTotalQrs / qrsPerPart)),
            qrsPerPart
        };
    }

    const qrsPerPart = Math.min(safeTotalQrs, BULK_EXPORT_MAX_QRS_PER_PART);
    return {
        partCount: Math.max(1, Math.ceil(safeTotalQrs / qrsPerPart)),
        qrsPerPart
    };
};

const buildPartWindow = ({ partIndex, qrsPerPart, totalQrs, qrsPerSheet = null }) => {
    const safePartIndex = Math.max(0, Number.parseInt(partIndex, 10) || 0);
    const safeQrsPerPart = Math.max(1, Number.parseInt(qrsPerPart, 10) || 1);
    const safeTotalQrs = Math.max(0, Number.parseInt(totalQrs, 10) || 0);

    if (Number.isFinite(Number(qrsPerSheet)) && Number(qrsPerSheet) > 0) {
        const safeSheetSize = Number(qrsPerSheet);
        const startSheetIndex = Math.floor((safePartIndex * safeQrsPerPart) / safeSheetSize);
        const endExclusive = Math.min(safeTotalQrs, (safePartIndex + 1) * safeQrsPerPart);
        const sheetCount = Math.max(1, Math.ceil((endExclusive - startSheetIndex * safeSheetSize) / safeSheetSize));
        const offset = startSheetIndex * safeSheetSize;
        const limit = Math.min(safeTotalQrs - offset, sheetCount * safeSheetSize);

        return {
            offset,
            limit,
            startSheetIndex
        };
    }

    const offset = safePartIndex * safeQrsPerPart;
    const limit = Math.min(safeQrsPerPart, Math.max(0, safeTotalQrs - offset));
    return {
        offset,
        limit,
        startSheetIndex: 0
    };
};

const createZipFromFiles = async (destinationPath, files) => {
    await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(destinationPath);
        const archive = archiver('zip', { zlib: { level: 9 } });

        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        archive.pipe(output);

        files.forEach((file) => {
            archive.file(file.absolutePath, { name: file.archiveName });
        });

        const finalized = archive.finalize();
        if (finalized && typeof finalized.catch === 'function') {
            finalized.catch(reject);
        }
    });
};

const deleteFilesSilently = (files) => {
    files.forEach((filePath) => {
        try {
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }
        } catch (error) {
            console.error('[BulkExport] Failed to remove file:', filePath, error.message);
        }
    });
};

const describeInventoryScope = (seriesCode) =>
    seriesCode ? `Inventory (${seriesCode})` : 'Inventory (All Series)';

const buildCampaignJobTitle = (campaignTitle) => `Bulk QR export queued for "${campaignTitle}"`;
const buildInventoryJobTitle = (scopeLabel) => `Bulk inventory QR export queued for ${scopeLabel}`;
const buildCampaignActivationStartTitle = (campaignTitle) => `Campaign payment received for "${campaignTitle}"`;
const buildCampaignActivationReadyTitle = (campaignTitle) => `Campaign QRs ready for "${campaignTitle}"`;

const buildJobListItem = (job) => {
    const totalQrs = Math.max(0, Number(job?.totalQrs) || 0);
    const processedQrs = clampProgress(job?.processedQrs, totalQrs);
    const progressPercent = totalQrs > 0
        ? Math.min(100, Math.round((processedQrs / totalQrs) * 100))
        : 0;

    return {
        id: job.id,
        vendorId: job.vendorId,
        campaignId: job.campaignId,
        type: job.type,
        scopeLabel: job.scopeLabel,
        status: job.status,
        totalQrs,
        processedQrs,
        qrsPerSheet: job.qrsPerSheet,
        partCount: job.partCount,
        fileName: job.fileName,
        fileMimeType: job.fileMimeType,
        errorMsg: job.errorMsg,
        requestParams: job.requestParams,
        startedAt: job.startedAt,
        completedAt: job.completedAt,
        expiresAt: job.expiresAt,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        progressPercent,
        downloadPath: job.status === BULK_EXPORT_STATUS.COMPLETED ? getJobDownloadPath(job.id) : null,
        isReady: job.status === BULK_EXPORT_STATUS.COMPLETED
    };
};

const getCampaignExportCount = async (campaignId) => prisma.qRCode.count({
    where: {
        campaignId,
        status: {
            in: POSTPAID_SHEET_QR_STATUSES
        }
    }
});

const getInventoryExportCount = async (vendorId, seriesCode = null) => {
    const where = {
        vendorId,
        status: 'inventory'
    };
    if (seriesCode) {
        where.seriesCode = seriesCode;
    }
    return prisma.qRCode.count({ where });
};

const queueCampaignExportJob = async ({
    vendorId,
    campaignId,
    qrsPerSheet,
    splitParts = true,
    requestedByUserId = null
}) => {
    const campaign = await prisma.campaign.findUnique({
        where: { id: campaignId },
        include: {
            Brand: {
                select: {
                    vendorId: true,
                    name: true,
                    logoUrl: true
                }
            },
            Product: { select: { name: true } }
        }
    });

    if (!campaign || campaign.Brand?.vendorId !== vendorId) {
        const error = new Error('Campaign not found');
        error.status = 404;
        throw error;
    }

    if (campaign.status !== 'active') {
        const error = new Error('Bulk QR export is only available for active campaigns');
        error.status = 400;
        throw error;
    }

    // Deduplicate: return existing job if one is already queued, processing, or recently completed
    try {
        const existingJob = await prisma.bulkExportJob.findFirst({
            where: {
                campaignId,
                vendorId,
                type: BULK_EXPORT_TYPE.CAMPAIGN_QR_PDF,
                status: { in: [BULK_EXPORT_STATUS.QUEUED, BULK_EXPORT_STATUS.PROCESSING] }
            },
            orderBy: { createdAt: 'desc' }
        });
        if (existingJob) {
            return buildJobListItem(existingJob);
        }
    } catch (dedupeError) {
        if (!isMissingBulkExportTableError(dedupeError)) {
            console.error('[BulkExport] Dedup check failed:', dedupeError.message);
        }
    }

    const totalQrs = await getCampaignExportCount(campaignId);
    if (!totalQrs) {
        const error = new Error('No QR codes found for this campaign');
        error.status = 400;
        throw error;
    }

    const resolvedQrsPerSheet =
        campaign.planType === 'postpaid'
            ? resolvePostpaidSheetSize(totalQrs, qrsPerSheet)
            : null;
    const partPlan = calculatePartPlan({
        totalQrs,
        qrsPerSheet: resolvedQrsPerSheet,
        splitParts
    });

    try {
        const job = await prisma.bulkExportJob.create({
            data: {
                vendorId,
                campaignId,
                type: BULK_EXPORT_TYPE.CAMPAIGN_QR_PDF,
                scopeLabel: campaign.title,
                status: BULK_EXPORT_STATUS.QUEUED,
                totalQrs,
                processedQrs: 0,
                qrsPerSheet: resolvedQrsPerSheet,
                partCount: partPlan.partCount,
                expiresAt: buildExpiryDate(),
                requestParams: {
                    planType: campaign.planType,
                    splitParts: splitParts !== false,
                    requestedByUserId,
                    requestedQrsPerSheet: toPositiveInt(qrsPerSheet),
                    resolvedQrsPerSheet
                }
            }
        });

        await safeCreateVendorNotification({
            vendorId,
            title: buildCampaignJobTitle(campaign.title),
            message: `${totalQrs.toLocaleString()} QR codes are being prepared in the background.`,
            type: 'bulk-export-started',
            metadata: {
                tab: 'campaigns',
                campaignId,
                jobId: job.id,
                totalQrs,
                partCount: partPlan.partCount
            }
        });

        return buildJobListItem(job);
    } catch (error) {
        if (isMissingBulkExportTableError(error)) {
            throw buildBulkExportUnavailableError();
        }
        throw error;
    }
};

const queueInventoryExportJob = async ({
    vendorId,
    seriesCode = null,
    splitParts = true,
    requestedByUserId = null
}) => {
    const scopeLabel = describeInventoryScope(seriesCode);
    const totalQrs = await getInventoryExportCount(vendorId, seriesCode);

    if (!totalQrs) {
        const error = new Error(
            seriesCode
                ? `No inventory QR codes available for series "${seriesCode}".`
                : 'No inventory QR codes available for export.'
        );
        error.status = 404;
        throw error;
    }

    const partPlan = calculatePartPlan({
        totalQrs,
        splitParts
    });

    try {
        const existingJob = await prisma.bulkExportJob.findFirst({
            where: {
                vendorId,
                type: BULK_EXPORT_TYPE.INVENTORY_QR_PDF,
                status: { in: [BULK_EXPORT_STATUS.QUEUED, BULK_EXPORT_STATUS.PROCESSING] },
                requestParams: { path: ['seriesCode'], equals: seriesCode }
            },
            orderBy: { createdAt: 'desc' }
        });

        if (existingJob) {
            return buildJobListItem(existingJob);
        }
    } catch (dedupeError) {
        if (!isMissingBulkExportTableError(dedupeError)) {
            console.error('[BulkExport] Dedup check failed:', dedupeError.message);
        }
    }

    try {
        const job = await prisma.bulkExportJob.create({
            data: {
                vendorId,
                type: BULK_EXPORT_TYPE.INVENTORY_QR_PDF,
                scopeLabel,
                status: BULK_EXPORT_STATUS.QUEUED,
                totalQrs,
                processedQrs: 0,
                partCount: partPlan.partCount,
                expiresAt: buildExpiryDate(),
                requestParams: {
                    requestedByUserId,
                    seriesCode,
                    splitParts: splitParts !== false
                }
            }
        });

        await safeCreateVendorNotification({
            vendorId,
            title: buildInventoryJobTitle(scopeLabel),
            message: `${totalQrs.toLocaleString()} inventory QR codes are being packaged in the background.`,
            type: 'bulk-export-started',
            metadata: {
                tab: 'campaigns',
                jobId: job.id,
                totalQrs,
                partCount: partPlan.partCount,
                seriesCode: seriesCode || null
            }
        });

        return buildJobListItem(job);
    } catch (error) {
        if (isMissingBulkExportTableError(error)) {
            throw buildBulkExportUnavailableError();
        }
        throw error;
    }
};

const queueCampaignActivationJob = async ({
    db = prisma,
    vendorId,
    campaignId,
    campaignBudgetId,
    campaignTitle,
    totalQrs,
    totalCost,
    rows,
    selectedSeries = null,
    requestedByUserId = null
}) => {
    const normalizedRows = Array.isArray(rows)
        ? rows
            .map((row) => ({
                quantity: Math.max(0, Number.parseInt(row?.quantity, 10) || 0),
                cashbackAmount: Number(row?.cashbackAmount || 0)
            }))
            .filter((row) => row.quantity > 0)
        : [];

    if (!normalizedRows.length) {
        const error = new Error('No valid QR funding rows were provided');
        error.status = 400;
        throw error;
    }

    try {
        const job = await db.bulkExportJob.create({
            data: {
                vendorId,
                campaignId,
                type: BULK_EXPORT_TYPE.CAMPAIGN_ACTIVATION,
                scopeLabel: campaignTitle,
                status: BULK_EXPORT_STATUS.QUEUED,
                totalQrs,
                processedQrs: 0,
                partCount: 1,
                expiresAt: buildExpiryDate(),
                requestParams: {
                    campaignBudgetId,
                    rows: normalizedRows,
                    selectedSeries,
                    totalCost,
                    requestedByUserId
                }
            }
        });

        return buildJobListItem(job);
    } catch (error) {
        if (isMissingBulkExportTableError(error)) {
            throw buildBulkExportUnavailableError();
        }
        throw error;
    }
};

const fetchCampaignPartQrs = async ({ campaignId, offset, limit }) => prisma.qRCode.findMany({
    where: {
        campaignId,
        status: {
            in: POSTPAID_SHEET_QR_STATUSES
        }
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    skip: offset,
    take: limit,
    select: {
        uniqueHash: true,
        cashbackAmount: true,
        status: true
    }
});

const fetchInventoryPartQrs = async ({ vendorId, seriesCode = null, offset, limit }) => {
    const where = {
        vendorId,
        status: 'inventory'
    };
    if (seriesCode) {
        where.seriesCode = seriesCode;
    }

    return prisma.qRCode.findMany({
        where,
        orderBy: [
            { seriesCode: 'asc' },
            { seriesOrder: 'asc' },
            { createdAt: 'asc' },
            { id: 'asc' }
        ],
        skip: offset,
        take: limit,
        select: {
            uniqueHash: true,
            cashbackAmount: true
        }
    });
};

const finalizeJobArtifact = async ({ job, artifactPath, fileName, fileMimeType }) => {
    await updateProcessingJobOrThrow(job.id, {
        status: BULK_EXPORT_STATUS.COMPLETED,
        processedQrs: job.totalQrs,
        filePath: artifactPath,
        fileName,
        fileMimeType,
        errorMsg: null,
        completedAt: new Date()
    });

    await safeCreateVendorNotification({
        vendorId: job.vendorId,
        title: 'Bulk QR export ready',
        message: `${job.scopeLabel || 'Your export'} is ready to download.`,
        type: 'bulk-export-ready',
        metadata: {
            tab: 'campaigns',
            jobId: job.id,
            campaignId: job.campaignId || null,
            totalQrs: job.totalQrs,
            partCount: job.partCount,
            downloadPath: getJobDownloadPath(job.id)
        }
    });
};

const failJob = async (job, error) => {
    const message = String(error?.message || 'Bulk export failed');
    const isActivationJob = job.type === BULK_EXPORT_TYPE.CAMPAIGN_ACTIVATION;

    const result = await prisma.bulkExportJob.updateMany({
        where: {
            id: job.id,
            status: {
                in: [BULK_EXPORT_STATUS.QUEUED, BULK_EXPORT_STATUS.PROCESSING]
            }
        },
        data: {
            status: BULK_EXPORT_STATUS.FAILED,
            errorMsg: message,
            completedAt: new Date()
        }
    });

    // Job was cancelled/deleted/already completed by another operation.
    if (!result.count) {
        return;
    }

    await safeCreateVendorNotification({
        vendorId: job.vendorId,
        title: isActivationJob ? 'Campaign QR funding failed' : 'Bulk QR export failed',
        message,
        type: isActivationJob ? 'campaign-activation-failed' : 'bulk-export-failed',
        metadata: {
            tab: 'campaigns',
            jobId: job.id,
            campaignId: job.campaignId || null
        }
    });
};

const processCampaignJob = async (job) => {
    const requestParams = job.requestParams && typeof job.requestParams === 'object'
        ? job.requestParams
        : {};
    const campaign = await prisma.campaign.findUnique({
        where: { id: job.campaignId },
        include: {
            Product: { select: { name: true } },
            Brand: {
                select: {
                    name: true,
                    logoUrl: true
                }
            }
        }
    });

    if (!campaign) {
        throw new Error('Campaign not found while processing export');
    }

    const totalQrs = await getCampaignExportCount(job.campaignId);
    if (!totalQrs) {
        throw new Error('No QR codes found while processing export');
    }

    const resolvedQrsPerSheet =
        campaign.planType === 'postpaid'
            ? resolvePostpaidSheetSize(totalQrs, requestParams.resolvedQrsPerSheet || job.qrsPerSheet)
            : null;
    const partPlan = calculatePartPlan({
        totalQrs,
        qrsPerSheet: resolvedQrsPerSheet,
        splitParts: requestParams.splitParts !== false
    });

    await prisma.bulkExportJob.update({
        where: { id: job.id },
        data: {
            totalQrs,
            qrsPerSheet: resolvedQrsPerSheet,
            partCount: partPlan.partCount
        }
    });

    const jobDir = getJobDirectory(job.id);
    fs.mkdirSync(jobDir, { recursive: true });

    const partFiles = [];
    let processedBeforePart = 0;

    for (let partIndex = 0; partIndex < partPlan.partCount; partIndex += 1) {
        await assertJobProcessingOrThrow(job.id);

        const partWindow = buildPartWindow({
            partIndex,
            qrsPerPart: partPlan.qrsPerPart,
            totalQrs,
            qrsPerSheet: resolvedQrsPerSheet
        });
        const partQrs = await fetchCampaignPartQrs({
            campaignId: job.campaignId,
            offset: partWindow.offset,
            limit: partWindow.limit
        });

        if (!partQrs.length) {
            continue;
        }

        const archiveName = partPlan.partCount > 1
            ? `${sanitizeStem(campaign.title, 'campaign')}_Part_${partIndex + 1}.pdf`
            : `${sanitizeStem(campaign.title, 'campaign')}.pdf`;
        const absolutePath = path.join(jobDir, archiveName);
        const progressUpdater = buildProgressUpdater(job.id, totalQrs, processedBeforePart);

        await generateQrPdfToFile(absolutePath, {
            qrCodes: partQrs,
            campaignTitle: campaign.title,
            orderId: campaign.id,
            brandName: campaign.Brand?.name,
            brandLogoUrl: campaign.Brand?.logoUrl,
            planType: campaign.planType,
            productName: campaign.Product?.name || null,
            startSheetIndex: campaign.planType === 'postpaid' ? partWindow.startSheetIndex : 0,
            totalSheetCount: campaign.planType === 'postpaid'
                ? Math.max(1, Math.ceil(totalQrs / resolvedQrsPerSheet))
                : undefined,
            qrsPerSheet: resolvedQrsPerSheet,
            voucherDesignUrl: campaign.voucherDesignUrl || null,
            voucherHeading: campaign.voucherHeading || null,
            voucherSubtext: campaign.voucherSubtext || null,
            allocations: campaign.allocations,
            voucherExtraText: campaign.voucherExtraText || null,
            onProgress: progressUpdater
        });

        processedBeforePart += partQrs.length;
        partFiles.push({
            absolutePath,
            archiveName
        });
    }

    if (!partFiles.length) {
        throw new Error('No export files were generated');
    }

    if (partFiles.length === 1) {
        const onlyFile = partFiles[0];
        const finalName = sanitizeStem(`QR_Campaign_${campaign.id.slice(-8)}_${campaign.title}`, `QR_Campaign_${campaign.id.slice(-8)}`) + '.pdf';
        const finalPath = path.join(jobDir, finalName);

        if (onlyFile.absolutePath !== finalPath) {
            fs.renameSync(onlyFile.absolutePath, finalPath);
        }

        await finalizeJobArtifact({
            job: { ...job, totalQrs, partCount: 1 },
            artifactPath: finalPath,
            fileName: finalName,
            fileMimeType: 'application/pdf'
        });
        return;
    }

    const zipName = sanitizeStem(`QR_Campaign_${campaign.id.slice(-8)}_${campaign.title}_Bulk_Export`, `QR_Campaign_${campaign.id.slice(-8)}_Bulk_Export`) + '.zip';
    const zipPath = path.join(jobDir, zipName);
    await createZipFromFiles(zipPath, partFiles);
    deleteFilesSilently(partFiles.map((item) => item.absolutePath));

    await finalizeJobArtifact({
        job: { ...job, totalQrs, partCount: partFiles.length },
        artifactPath: zipPath,
        fileName: zipName,
        fileMimeType: 'application/zip'
    });
};

const processInventoryJob = async (job) => {
    const requestParams = job.requestParams && typeof job.requestParams === 'object'
        ? job.requestParams
        : {};
    const seriesCode = typeof requestParams.seriesCode === 'string' && requestParams.seriesCode.trim()
        ? requestParams.seriesCode.trim()
        : null;
    const totalQrs = await getInventoryExportCount(job.vendorId, seriesCode);
    if (!totalQrs) {
        throw new Error('No inventory QR codes found while processing export');
    }

    const partPlan = calculatePartPlan({
        totalQrs,
        splitParts: requestParams.splitParts !== false
    });

    await prisma.bulkExportJob.update({
        where: { id: job.id },
        data: {
            totalQrs,
            partCount: partPlan.partCount
        }
    });

    const jobDir = getJobDirectory(job.id);
    fs.mkdirSync(jobDir, { recursive: true });

    const partFiles = [];
    let processedBeforePart = 0;

    for (let partIndex = 0; partIndex < partPlan.partCount; partIndex += 1) {
        await assertJobProcessingOrThrow(job.id);

        const offset = partIndex * partPlan.qrsPerPart;
        const limit = Math.min(partPlan.qrsPerPart, totalQrs - offset);
        const partQrs = await fetchInventoryPartQrs({
            vendorId: job.vendorId,
            seriesCode,
            offset,
            limit
        });

        if (!partQrs.length) {
            continue;
        }

        const partLabel = seriesCode ? `Inventory_${seriesCode}` : 'Inventory_All';
        const archiveName = partPlan.partCount > 1
            ? `${sanitizeStem(partLabel, 'Inventory')}_Part_${partIndex + 1}.pdf`
            : `${sanitizeStem(partLabel, 'Inventory')}.pdf`;
        const absolutePath = path.join(jobDir, archiveName);
        const progressUpdater = buildProgressUpdater(job.id, totalQrs, processedBeforePart);

        await generateQrPdfToFile(absolutePath, {
            qrCodes: partQrs,
            campaignTitle: describeInventoryScope(seriesCode),
            orderId: `inventory-${job.vendorId.slice(-6)}`,
            brandName: 'Vendor Inventory',
            onProgress: progressUpdater
        });

        processedBeforePart += partQrs.length;
        partFiles.push({
            absolutePath,
            archiveName
        });
    }

    if (!partFiles.length) {
        throw new Error('No export files were generated');
    }

    if (partFiles.length === 1) {
        const onlyFile = partFiles[0];
        const finalName = sanitizeStem(`QR_Inventory_${seriesCode || 'all'}_Bulk_Export`, 'QR_Inventory_Bulk_Export') + '.pdf';
        const finalPath = path.join(jobDir, finalName);

        if (onlyFile.absolutePath !== finalPath) {
            fs.renameSync(onlyFile.absolutePath, finalPath);
        }

        await finalizeJobArtifact({
            job: { ...job, totalQrs, partCount: 1 },
            artifactPath: finalPath,
            fileName: finalName,
            fileMimeType: 'application/pdf'
        });
        return;
    }

    const zipName = sanitizeStem(`QR_Inventory_${seriesCode || 'all'}_Bulk_Export`, 'QR_Inventory_Bulk_Export') + '.zip';
    const zipPath = path.join(jobDir, zipName);
    await createZipFromFiles(zipPath, partFiles);
    deleteFilesSilently(partFiles.map((item) => item.absolutePath));

    await finalizeJobArtifact({
        job: { ...job, totalQrs, partCount: partFiles.length },
        artifactPath: zipPath,
        fileName: zipName,
        fileMimeType: 'application/zip'
    });
};

const processCampaignActivationJob = async (job) => {
    const requestParams = job.requestParams && typeof job.requestParams === 'object'
        ? job.requestParams
        : {};
    const rows = Array.isArray(requestParams.rows) ? requestParams.rows : [];
    const selectedSeries = typeof requestParams.selectedSeries === 'string' && requestParams.selectedSeries.trim()
        ? requestParams.selectedSeries.trim()
        : null;
    const campaignBudgetId = typeof requestParams.campaignBudgetId === 'string' && requestParams.campaignBudgetId.trim()
        ? requestParams.campaignBudgetId.trim()
        : null;

    const campaign = await prisma.campaign.findUnique({
        where: { id: job.campaignId },
        include: {
            Brand: {
                select: {
                    vendorId: true
                }
            }
        }
    });

    if (!campaign || campaign.Brand?.vendorId !== job.vendorId) {
        throw new Error('Campaign not found while funding QRs');
    }

    if (!campaignBudgetId) {
        throw new Error('Campaign budget reference is missing for background funding');
    }

    let processedCount = 0;
    for (const row of rows) {
        await assertJobProcessingOrThrow(job.id);

        await allocateInventoryQrs(prisma, {
            vendorId: job.vendorId,
            campaignId: job.campaignId,
            campaignBudgetId,
            quantity: row.quantity,
            cashbackAmount: row.cashbackAmount,
            orderId: null,
            seriesCode: selectedSeries,
            onProgress: async ({ fundedCount }) => {
                const nextProcessed = clampProgress(processedCount + fundedCount, job.totalQrs);
                await updateProcessingJobOrThrow(job.id, {
                    processedQrs: nextProcessed
                });
            }
        });

        processedCount += row.quantity;
    }

    await updateProcessingJobOrThrow(job.id, {
        status: BULK_EXPORT_STATUS.COMPLETED,
        processedQrs: job.totalQrs,
        errorMsg: null,
        completedAt: new Date()
    });

    await safeCreateVendorNotification({
        vendorId: job.vendorId,
        title: buildCampaignActivationReadyTitle(campaign.title),
        message: `${job.totalQrs.toLocaleString()} QRs are funded and ready for campaign "${campaign.title}".`,
        type: 'campaign-activation-ready',
        metadata: {
            tab: 'campaigns',
            campaignId: job.campaignId,
            jobId: job.id,
            totalQrs: job.totalQrs
        }
    });
};

const claimNextQueuedJob = async () => {
    try {
        const queuedJob = await prisma.bulkExportJob.findFirst({
            where: { status: BULK_EXPORT_STATUS.QUEUED },
            orderBy: { createdAt: 'asc' }
        });
        if (!queuedJob) return null;

        const result = await prisma.bulkExportJob.updateMany({
            where: {
                id: queuedJob.id,
                status: BULK_EXPORT_STATUS.QUEUED
            },
            data: {
                status: BULK_EXPORT_STATUS.PROCESSING,
                startedAt: new Date(),
                errorMsg: null
            }
        });

        if (!result.count) {
            return null;
        }

        return prisma.bulkExportJob.findUnique({
            where: { id: queuedJob.id }
        });
    } catch (error) {
        if (isMissingBulkExportTableError(error)) {
            return null;
        }
        throw error;
    }
};

const processClaimedJob = async (job) => {
    try {
        if (job.type === BULK_EXPORT_TYPE.CAMPAIGN_QR_PDF) {
            await processCampaignJob(job);
            return;
        }
        if (job.type === BULK_EXPORT_TYPE.INVENTORY_QR_PDF) {
            await processInventoryJob(job);
            return;
        }
        if (job.type === BULK_EXPORT_TYPE.CAMPAIGN_ACTIVATION) {
            await processCampaignActivationJob(job);
            return;
        }
        throw new Error(`Unsupported export job type: ${job.type}`);
    } catch (error) {
        if (isCancelledJobError(error)) {
            return;
        }
        await failJob(job, error);
        throw error;
    }
};

const processNextQueuedJobSafely = async () => {
    if (workerBusy) return;
    workerBusy = true;

    try {
        const job = await claimNextQueuedJob();
        if (!job) return;
        await processClaimedJob(job);
    } catch (error) {
        console.error('[BulkExport] Worker failure:', error.message);
    } finally {
        workerBusy = false;
    }
};

const startBulkExportWorker = () => {
    ensureExportRootDir();
    if (workerInterval) return workerInterval;

    // Removed automatic processing-job reset to prevent DB driver crash loops on startup.
    // Stuck jobs can be safely ignored or cleaned up via admin scripts.

    workerInterval = setInterval(() => {
        processNextQueuedJobSafely().catch((error) => {
            console.error('[BulkExport] Unhandled worker tick error:', error.message);
        });
    }, BULK_EXPORT_WORKER_INTERVAL_MS);

    processNextQueuedJobSafely().catch((error) => {
        console.error('[BulkExport] Initial worker run failed:', error.message);
    });

    return workerInterval;
};

const listVendorBulkExportJobs = async (vendorId, limit = 20) => {
    const safeLimit = Math.min(50, Math.max(1, Number.parseInt(limit, 10) || 20));
    try {
        const jobs = await prisma.bulkExportJob.findMany({
            where: {
                vendorId,
                type: {
                    in: [
                        BULK_EXPORT_TYPE.CAMPAIGN_QR_PDF,
                        BULK_EXPORT_TYPE.INVENTORY_QR_PDF
                    ]
                }
            },
            orderBy: { createdAt: 'desc' },
            take: safeLimit
        });

        return jobs.map(buildJobListItem);
    } catch (error) {
        if (isMissingBulkExportTableError(error)) {
            return [];
        }
        throw error;
    }
};

const getVendorBulkExportJob = async (vendorId, jobId) => {
    let job;
    try {
        job = await prisma.bulkExportJob.findFirst({
            where: {
                id: jobId,
                vendorId
            }
        });
    } catch (error) {
        if (isMissingBulkExportTableError(error)) {
            throw buildBulkExportUnavailableError();
        }
        throw error;
    }

    if (!job) {
        const error = new Error('Export job not found');
        error.status = 404;
        throw error;
    }

    return buildJobListItem(job);
};

const getVendorBulkExportArtifact = async (vendorId, jobId) => {
    let job;
    try {
        job = await prisma.bulkExportJob.findFirst({
            where: {
                id: jobId,
                vendorId
            }
        });
    } catch (error) {
        if (isMissingBulkExportTableError(error)) {
            throw buildBulkExportUnavailableError();
        }
        throw error;
    }

    if (!job) {
        const error = new Error('Export job not found');
        error.status = 404;
        throw error;
    }

    if (job.status !== BULK_EXPORT_STATUS.COMPLETED || !job.filePath || !job.fileName) {
        const error = new Error('Export file is not ready yet');
        error.status = 409;
        throw error;
    }

    if (!fs.existsSync(job.filePath)) {
        const error = new Error('Export file is no longer available');
        error.status = 410;
        throw error;
    }

    return {
        absolutePath: job.filePath,
        fileName: job.fileName,
        fileMimeType: job.fileMimeType || 'application/octet-stream'
    };
};

module.exports = {
    BULK_EXPORT_STATUS,
    BULK_EXPORT_TYPE,
    BULK_EXPORT_MAX_QRS_PER_PART,
    getJobDownloadPath,
    getVendorBulkExportArtifact,
    getVendorBulkExportJob,
    listVendorBulkExportJobs,
    queueCampaignActivationJob,
    queueCampaignExportJob,
    queueInventoryExportJob,
    startBulkExportWorker
};
