
const STANDARD_RAM_SIZES = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
const STANDARD_DISK_SIZES = [25, 50, 80, 100, 160, 250, 500, 1000, 2000, 4000];

/**
 * Rounds a value up to the next standard cloud hardware tier.
 */
const roundToStandardTier = (value, tiers) => {
    for (const tier of tiers) {
        if (tier >= value) return tier;
    }
    return Math.ceil(value / 64) * 64;
};

/**
 * Calculates server resource requirements based on workload parameters.
 * @param {object} params
 * @param {number} [params.peakRps=100] - Peak Requests Per Second
 * @param {number} [params.avgLatencyMs=50] - Average response latency in ms
 * @param {number} [params.payloadSizeKb=5] - Average request/response payload in KB
 * @param {number} [params.dataStorageGb=20] - Current base data storage in GB
 * @param {number} [params.dailyGrowthMb=500] - Daily data ingestion / growth in MB
 * @param {number} [params.retentionDays=365] - Log / data retention in days
 * @param {number} [params.cacheHitRatio=0.85] - Cache hit ratio (0.0 to 1.0)
 * @param {string} [params.workloadType='web_api'] - 'web_api', 'compute_heavy', 'database', 'streaming_io'
 * @param {number} [params.targetCpuUtilization=0.70] - Target peak CPU utilization (0.50 - 0.85)
 * @returns {object} Detailed server sizing calculation
 */
function calculateServerResources(params = {}) {
    const peakRps = Math.max(1, Number(params.peakRps) || 100);
    const avgLatencyMs = Math.max(1, Number(params.avgLatencyMs) || 50);
    const payloadSizeKb = Math.max(0.5, Number(params.payloadSizeKb) || 5);
    const dataStorageGb = Math.max(1, Number(params.dataStorageGb) || 20);
    const dailyGrowthMb = Math.max(0, Number(params.dailyGrowthMb) || 500);
    const retentionDays = Math.max(1, Number(params.retentionDays) || 365);
    const cacheHitRatio = Math.min(0.99, Math.max(0, Number(params.cacheHitRatio) || 0.85));
    const workloadType = String(params.workloadType || 'web_api').toLowerCase();
    const targetUtilization = Math.min(0.9, Math.max(0.4, Number(params.targetCpuUtilization) || 0.70));

    // 1. Concurrency (Little's Law: L = λ * W)
    const latencySeconds = avgLatencyMs / 1000;
    const concurrentRequests = Math.max(1, Math.round(peakRps * latencySeconds));

    // 2. CPU Calculation
    // Ratio of active CPU execution time vs async I/O waiting time:
    let cpuActiveRatio = 0.25; // Standard async web API (25% CPU, 75% DB/Network I/O waiting)
    if (workloadType === 'compute_heavy') cpuActiveRatio = 0.85; // Image/video/crypto
    else if (workloadType === 'database') cpuActiveRatio = 0.45; // Query compilation & indexing
    else if (workloadType === 'streaming_io') cpuActiveRatio = 0.10; // Socket dispatching

    const cpuTimePerRequestSeconds = latencySeconds * cpuActiveRatio;
    const rawVcpus = (peakRps * cpuTimePerRequestSeconds) / targetUtilization;
    // Add 1 core for OS background daemons, monitoring, and kernel I/O handling
    const requiredVcpus = Math.max(1, Math.ceil(rawVcpus + 1));
    const recommendedWorkers = Math.max(1, requiredVcpus);

    // 3. RAM Calculation (Breakdown in GB)
    const osReserveGb = requiredVcpus > 8 ? 2.0 : 1.0;
    
    // Application heap per worker (Node.js ~512MB-1.5GB, Go ~256MB, Java ~1-2GB)
    const appHeapPerWorkerMb = workloadType === 'compute_heavy' ? 1024 : 512;
    const appHeapGb = (recommendedWorkers * appHeapPerWorkerMb) / 1024;

    // Connection memory overhead (~256KB to 512KB per active socket)
    const connectionMemoryGb = (concurrentRequests * 0.5) / 1024;

    // Database Buffer Pool (if DB workload or caching)
    let dbBufferPoolGb = 0;
    if (workloadType === 'database') {
        dbBufferPoolGb = Math.max(2, dataStorageGb * 0.5); // 50% of working data in buffer pool
    }

    // In-memory cache reserve (Redis/Memcached working set)
    const cacheReserveGb = workloadType === 'database' ? 1.0 : Math.max(0.5, peakRps * 0.005);

    const rawTotalRamGb = osReserveGb + appHeapGb + connectionMemoryGb + dbBufferPoolGb + cacheReserveGb;
    const totalRamGb = roundToStandardTier(Math.ceil(rawTotalRamGb * 1.25), STANDARD_RAM_SIZES);

    // 4. Storage Calculation (Capacity & IOPS)
    const osAndBinariesGb = 30; // Ubuntu/Debian + Docker + Logs
    const projectedGrowthGb = (dailyGrowthMb * retentionDays) / 1024;
    const safetyAndWalBufferGb = (dataStorageGb + projectedGrowthGb) * 0.35; // 35% WAL, temp tables & safety
    const rawDiskGb = osAndBinariesGb + dataStorageGb + projectedGrowthGb + safetyAndWalBufferGb;
    const totalDiskGb = roundToStandardTier(Math.ceil(rawDiskGb), STANDARD_DISK_SIZES);

    // IOPS Estimation
    const readRps = peakRps * (1 - cacheHitRatio);
    const writeRps = peakRps * 0.2; // Assuming ~20% of requests perform disk writes
    const requiredIops = Math.max(300, Math.ceil(writeRps * 4 + readRps * 2));
    const throughputMbSec = Math.max(10, Math.ceil((requiredIops * 16) / 1024)); // 16KB avg block

    let recommendedDiskType = 'Standard SSD';
    if (requiredIops > 10000 || totalDiskGb > 1000) {
        recommendedDiskType = 'NVMe SSD / Provisioned IOPS (AWS io2 / GCP Extreme PD)';
    } else if (requiredIops > 3000) {
        recommendedDiskType = 'High Performance NVMe SSD (AWS gp3 with boosted IOPS / Hetzner NVMe)';
    } else {
        recommendedDiskType = 'General Purpose SSD (AWS gp3 / DigitalOcean SSD)';
    }

    // 5. Network Bandwidth Calculation
    const bandwidthMbps = Math.ceil(((peakRps * payloadSizeKb * 8) / 1024) * 1.5); // 1.5x burst safety
    const monthlyEgressGb = Math.ceil(((peakRps * payloadSizeKb * 3600 * 24 * 30 * 0.3) / (1024 * 1024))); // assuming 30% duty cycle

    // 6. Cloud Instance Sizing Recommendations
    const cloudRecommendations = getCloudRecommendations(requiredVcpus, totalRamGb);

    return {
        inputs: {
            peakRps,
            avgLatencyMs,
            payloadSizeKb,
            dataStorageGb,
            dailyGrowthMb,
            retentionDays,
            cacheHitRatio: `${(cacheHitRatio * 100).toFixed(0)}%`,
            workloadType,
            targetCpuUtilization: `${(targetUtilization * 100).toFixed(0)}%`,
        },
        concurrency: {
            activeConnections: concurrentRequests,
            formula: `Little's Law: L = ${peakRps} RPS * ${latencySeconds}s = ${concurrentRequests} concurrent requests`,
        },
        cpu: {
            vcpus: requiredVcpus,
            recommendedWorkers,
            targetUtilization: `${(targetUtilization * 100).toFixed(0)}%`,
            formula: `((${peakRps} RPS * ${latencySeconds}s * ${cpuActiveRatio}) / ${targetUtilization}) + 1 OS core = ${requiredVcpus} vCPUs`,
        },
        ram: {
            totalRamGb,
            breakdown: {
                osReserveGb: Number(osReserveGb.toFixed(2)),
                appHeapGb: Number(appHeapGb.toFixed(2)),
                connectionMemoryGb: Number(connectionMemoryGb.toFixed(2)),
                dbBufferPoolGb: Number(dbBufferPoolGb.toFixed(2)),
                cacheReserveGb: Number(cacheReserveGb.toFixed(2)),
                safetyHeadroomGb: Number((totalRamGb - rawTotalRamGb).toFixed(2)),
            },
        },
        storage: {
            totalDiskGb,
            estimatedIops: requiredIops,
            throughputMbSec,
            recommendedDiskType,
            breakdown: {
                osAndBinariesGb,
                currentDataGb: dataStorageGb,
                projectedGrowthGb: Number(projectedGrowthGb.toFixed(2)),
                safetyAndWalGb: Number(safetyAndWalBufferGb.toFixed(2)),
            },
        },
        network: {
            peakBandwidthMbps: bandwidthMbps,
            projectedMonthlyEgressGb: monthlyEgressGb,
        },
        cloudRecommendations,
        diagnosticCommands: {
            cpu: 'lscpu && top -bn1 | head -15',
            ram: 'free -h && cat /proc/meminfo | head -10',
            storage: 'df -hT && lsblk && iostat -xz 1 2',
            network: 'ss -s && ss -tulpn',
        },
    };
}

/**
 * Maps required vCPU and RAM to standard Cloud Providers.
 */
function getCloudRecommendations(vcpus, ramGb) {
    const isSmall = vcpus <= 2 && ramGb <= 4;
    const isMedium = vcpus <= 4 && ramGb <= 16;
    const isLarge = vcpus <= 8 && ramGb <= 32;

    if (isSmall) {
        return {
            aws: { instanceType: 't4g.medium or t4g.large', specs: '2 vCPU / 4 GB RAM', estCostPerMonth: '$25 - $38' },
            gcp: { instanceType: 'e2-standard-2', specs: '2 vCPU / 8 GB RAM', estCostPerMonth: '$48' },
            digitalOcean: { instanceType: 'Basic Droplet', specs: '2 vCPU / 4 GB RAM', estCostPerMonth: '$24' },
            hetzner: { instanceType: 'CPX21 or CPX31', specs: '3-4 vCPU / 4-8 GB RAM', estCostPerMonth: '€7 - €14' },
        };
    }

    if (isMedium) {
        return {
            aws: { instanceType: 'c6i.xlarge or m6i.xlarge', specs: '4 vCPU / 8-16 GB RAM', estCostPerMonth: '$120 - $140' },
            gcp: { instanceType: 'e2-standard-4 or n2-standard-4', specs: '4 vCPU / 16 GB RAM', estCostPerMonth: '$98 - $140' },
            digitalOcean: { instanceType: 'General Purpose Droplet', specs: '4 vCPU / 16 GB RAM', estCostPerMonth: '$84' },
            hetzner: { instanceType: 'CPX41 or CCX23', specs: '4 vCPU / 16 GB RAM', estCostPerMonth: '€27 - €40' },
        };
    }

    if (isLarge) {
        return {
            aws: { instanceType: 'c6i.2xlarge or m6i.2xlarge', specs: '8 vCPU / 16-32 GB RAM', estCostPerMonth: '$240 - $280' },
            gcp: { instanceType: 'c2-standard-8 or n2-standard-8', specs: '8 vCPU / 32 GB RAM', estCostPerMonth: '$220 - $290' },
            digitalOcean: { instanceType: 'General Purpose / CPU-Optimized', specs: '8 vCPU / 32 GB RAM', estCostPerMonth: '$168' },
            hetzner: { instanceType: 'CCX33 (Dedicated vCPU)', specs: '8 vCPU / 32 GB RAM', estCostPerMonth: '€80' },
        };
    }

    return {
        aws: { instanceType: 'c6i.4xlarge or r6i.4xlarge', specs: `${vcpus} vCPU / ${ramGb} GB RAM`, estCostPerMonth: '$450+' },
        gcp: { instanceType: 'n2-standard-16 or c2-standard-16', specs: `${vcpus} vCPU / ${ramGb} GB RAM`, estCostPerMonth: '$430+' },
        digitalOcean: { instanceType: 'High Memory / Dedicated Droplet', specs: `${vcpus} vCPU / ${ramGb} GB RAM`, estCostPerMonth: '$330+' },
        hetzner: { instanceType: 'Dedicated Server (AX102 / EX101)', specs: '16-32 Core / 64-128 GB RAM NVMe', estCostPerMonth: '€110 - €150' },
    };
}

module.exports = {
    calculateServerResources,
    getCloudRecommendations,
    STANDARD_RAM_SIZES,
    STANDARD_DISK_SIZES,
};
