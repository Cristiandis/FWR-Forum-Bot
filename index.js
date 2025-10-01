const {
  Client,
  GatewayIntentBits,
  ChannelType,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require("discord.js");
const fs = require("fs");
require("dotenv").config();

const config = JSON.parse(fs.readFileSync("config.json", "utf8"));
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const lastActivity = new Map();
const threadOwners = new Map();
let checkInterval = null;

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();
  logConfiguration();
  await loadExistingThreads();
  startCheckInterval();
});

async function registerCommands() {
  const commands = [
    new SlashCommandBuilder()
      .setName("close")
      .setDescription("Close this support thread as resolved"),
    new SlashCommandBuilder()
      .setName("config")
      .setDescription("Configure the support bot (Admin only)")
      .addChannelOption((option) =>
        option
          .setName("forum")
          .setDescription("Forum channel to monitor")
          .addChannelTypes(ChannelType.GuildForum),
      )
      .addNumberOption((option) =>
        option
          .setName("hours")
          .setDescription("Hours before auto-close (1-720)")
          .setMinValue(1)
          .setMaxValue(720),
      )
      .addRoleOption((option) =>
        option
          .setName("supportrole")
          .setDescription("Role that can close threads"),
      )
      .addStringOption((option) =>
        option
          .setName("resolvedtag")
          .setDescription("Tag ID to apply when thread is resolved"),
      )
      .addStringOption((option) =>
        option
          .setName("inactivetag")
          .setDescription(
            "Tag ID to apply when thread is closed due to inactivity",
          ),
      )
      .setDefaultMemberPermissions("0"),
  ];

  try {
    await client.application.commands.set(commands);
    console.log("Slash commands registered successfully");
  } catch (error) {
    console.error("Error registering commands:", error);
  }
}

function logConfiguration() {
  console.log(`Monitoring: ${config.supportForumChannelId || "Not set"}`);
  console.log(`Auto-close after: ${config.inactivityHours} hours`);
}

async function loadExistingThreads() {
  if (!config.supportForumChannelId) return;

  try {
    const forum = await client.channels.fetch(config.supportForumChannelId);
    const threads = await forum.threads.fetchActive();

    for (const [id, thread] of threads.threads) {
      threadOwners.set(id, thread.ownerId);
    }

    console.log(`Loaded ${threadOwners.size} existing thread owners`);
  } catch (error) {
    console.error("Failed to load existing threads:", error);
  }
}

function startCheckInterval() {
  if (checkInterval) {
    clearInterval(checkInterval);
  }

  const checkFrequency = Math.max(
    10000,
    Math.min(config.inactivityHours * 60 * 60 * 250, 3600000),
  );

  console.log(
    `Check interval set to: ${(checkFrequency / 1000).toFixed(1)} seconds`,
  );
  checkInterval = setInterval(checkInactivity, checkFrequency);
  checkInactivity();
}

client.on("threadCreate", async (thread) => {
  if (thread.parentId !== config.supportForumChannelId) return;

  threadOwners.set(thread.id, thread.ownerId);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Support Thread")
    .setDescription(
      "Thank you for creating a support thread! Our team will assist you shortly.\n\nUse the button below to close this thread when your issue is resolved.",
    )
    .setTimestamp();

  const button = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("close_thread")
      .setLabel("Close Thread")
      .setStyle(ButtonStyle.Success)
      .setEmoji("✅"),
  );

  await thread.send({ embeds: [embed], components: [button] });
});

client.on("messageCreate", (message) => {
  if (message.author.bot) return;

  if (
    message.channel.type === ChannelType.PublicThread &&
    message.channel.parentId === config.supportForumChannelId
  ) {
    lastActivity.set(message.channel.id, Date.now());
  }
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isButton()) {
    await handleButtonInteraction(interaction);
    return;
  }

  if (interaction.isChatInputCommand()) {
    await handleCommandInteraction(interaction);
  }
});

async function handleButtonInteraction(interaction) {
  if (interaction.customId !== "close_thread") return;

  const thread = interaction.channel;
  const threadOwner = threadOwners.get(thread.id);
  const hasRole = config.supportRoleId
    ? interaction.member.roles.cache.has(config.supportRoleId)
    : false;
  const isOwner = interaction.user.id === threadOwner;

  if (!hasRole && !isOwner) {
    return interaction.reply({
      content: "Only the thread owner or support staff can close this thread",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply("Thread closed as resolved");
  await applyTag(thread, config.resolvedTagId);
  await thread.setLocked(true, `Closed by ${interaction.user.tag}`);
  await thread.setArchived(true, `Closed by ${interaction.user.tag}`);

  lastActivity.delete(thread.id);
  threadOwners.delete(thread.id);
}

async function handleCommandInteraction(interaction) {
  if (interaction.commandName === "close") {
    await handleCloseCommand(interaction);
  } else if (interaction.commandName === "config") {
    await handleConfigCommand(interaction);
  }
}

async function handleCloseCommand(interaction) {
  if (
    interaction.channel.type !== ChannelType.PublicThread ||
    interaction.channel.parentId !== config.supportForumChannelId
  ) {
    return interaction.reply({
      content: "Use this in a support thread only",
      flags: MessageFlags.Ephemeral,
    });
  }

  await interaction.reply("Thread closed as resolved");
  await applyTag(interaction.channel, config.resolvedTagId);
  await interaction.channel.setLocked(true, "Resolved by user");
  await interaction.channel.setArchived(true, "Resolved by user");

  lastActivity.delete(interaction.channel.id);
}

async function handleConfigCommand(interaction) {
  const forum = interaction.options.getChannel("forum");
  const hours = interaction.options.getNumber("hours");
  const supportRole = interaction.options.getRole("supportrole");
  const resolvedTag = interaction.options.getString("resolvedtag");
  const inactiveTag = interaction.options.getString("inactivetag");

  if (!forum && !hours && !supportRole && !resolvedTag && !inactiveTag) {
    return interaction.reply({
      content: "Provide at least one option to update",
      flags: MessageFlags.Ephemeral,
    });
  }

  if (forum) config.supportForumChannelId = forum.id;
  if (hours) config.inactivityHours = hours;
  if (supportRole) config.supportRoleId = supportRole.id;
  if (resolvedTag) config.resolvedTagId = resolvedTag;
  if (inactiveTag) config.inactiveTagId = inactiveTag;

  fs.writeFileSync("config.json", JSON.stringify(config, null, 2));

  if (hours) {
    startCheckInterval();
  }

  const updates = [
    forum && `Forum: ${forum.name}`,
    hours && `Timeout: ${hours}h`,
    supportRole && `Support Role: ${supportRole.name}`,
    resolvedTag && `Resolved Tag: ${resolvedTag}`,
    inactiveTag && `Inactive Tag: ${inactiveTag}`,
  ]
    .filter(Boolean)
    .join(" | ");

  await interaction.reply(`Updated: ${updates}`);
}

async function applyTag(thread, tagId) {
  if (!tagId) return;

  const existingTags = thread.appliedTags;
  if (!existingTags.includes(tagId)) {
    await thread.setAppliedTags([...existingTags, tagId]);
  }
}

async function checkInactivity() {
  if (!config.supportForumChannelId) return;

  try {
    const forum = await client.channels.fetch(config.supportForumChannelId);
    const threads = await forum.threads.fetchActive();
    const now = Date.now();
    const timeoutMs = config.inactivityHours * 60 * 60 * 1000;

    for (const [id, thread] of threads.threads) {
      if (thread.archived) continue;

      let lastTime = lastActivity.get(id);
      if (!lastTime) {
        const messages = await thread.messages.fetch({ limit: 1 });
        lastTime =
          messages.first()?.createdTimestamp || thread.createdTimestamp;
        lastActivity.set(id, lastTime);
      }

      if (now - lastTime >= timeoutMs) {
        await thread.send(
          `Closing due to ${config.inactivityHours}h inactivity`,
        );
        await applyTag(thread, config.inactiveTagId);
        await thread.setLocked(true, "Inactive");
        await thread.setArchived(true, "Inactive");

        lastActivity.delete(id);
      }
    }
  } catch (error) {
    console.error("Check failed:", error);
  }
}

client.login(process.env.DISCORD_TOKEN);
