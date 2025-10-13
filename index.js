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
  ThreadChannel,
  Message,
  Interaction
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

const MEMBER_REGEX = /^(?:(?:<@)?(\d{16,}))>?/

client.once("clientReady", async () => {
  console.log(`Logged in as ${client.user.tag}`);

  await registerCommands();
  logConfiguration();
  await loadExistingThreads();
  startCheckInterval();
});

// utility function
function checkAnyExcludedTags(appliedTags) {
  return (config?.excludedTags ?? []).some(tag => appliedTags.includes(tag))
}

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
      .addStringOption((option) =>
        option
          .setName("createdtag")
          .setDescription(
            "Tag ID to apply when thread is created (if the post has an excluded tag it won't be applied)",
          ),
      )
      .addStringOption((option) =>
        option
          .setName("excludetags")
          .setDescription(
            "list of Tag IDs that specifies which posts should be excluded from auto closing (separated with ,)",
          ),
      )
      .setDefaultMemberPermissions("0"),
    new SlashCommandBuilder()
      .setName("config-message")
      .setDescription("Configure the thread message upon opening a thread (Admin only)")
      .addStringOption((option) =>
        option
          .setName("text")
          .setDescription(
            "embed description to be sent upon thread creation",
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
      if (checkAnyExcludedTags(thread.appliedTags)) return;
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
/**
 * @param {ThreadChannel} thread - The thread that was created.
 */
client.on("threadCreate", async (thread) => {
  if (thread.parentId !== config.supportForumChannelId) return;
  if (checkAnyExcludedTags(thread.appliedTags)) return;
  if (config?.createdTag) {
    try {
      applyTag(thread, config.createdTag);
    } catch (e) {
      console.error(`failed to add tag: ${config?.createdTag} for ${thread.id} upon it's creation:\n${e}`);
    }
  }
  threadOwners.set(thread.id, thread.ownerId);

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Support Thread")
    .setDescription(
      config?.SupportThreadMessage ?? "Thank you for creating a support thread! Our team will assist you shortly.\n\nUse the button below to close this thread when your issue is resolved."
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
  processCommand(message)

  if (
    message.channel.type === ChannelType.PublicThread &&
    message.channel.parentId === config.supportForumChannelId &&
    checkAnyExcludedTags(message.channel.appliedTags)
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
  } else if (interaction.commandName === "config-message") {
    await handleConfigMessageCommand(interaction)
  }
}
/**
 * @param {Interaction} interaction
 */
async function handleConfigMessageCommand(interaction) {
  const description = interaction.options.getString("text");
  config.SupportThreadMessage = description;
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle("Support Thread (Preview)")
    .setDescription(
      config?.SupportThreadMessage ?? "Thank you for creating a support thread! Our team will assist you shortly.\n\nUse the button below to close this thread when your issue is resolved."
    )
    .setTimestamp();
  interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  fs.writeFileSync("config.json", JSON.stringify(config, null, 2));
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
  const excludedTags = interaction.options.getString("excludetags");
  const createTag = interaction.options.getString("createdtag");


  if (!forum && !hours && !supportRole && !resolvedTag && !inactiveTag && !excludedTags && !createTag) {
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
  if (excludedTags) config.excludedTags = excludedTags.split(',').map(tag => tag.trim());
  if (createTag) config.createdTag = createTag;

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
    createTag   && `create Tag: ${createTag}`,
    excludedTags&& `excluded Tags: ${excludedTags}`
  ]
    .filter(Boolean)
    .join(" | ");

  await interaction.reply(`Updated: ${updates}`);
}

async function applyTag(thread, tagId) {
  if (!tagId) return;

  const existingTags = thread.appliedTags;
if (existingTags.lenght >= 5) return;
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
      if (checkAnyExcludedTags(thread.appliedTags)) return;

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

////////// custom command 
/**
 * 
 * @param {string[]} authorRoles 
 * @returns {Set<string>}
 */
function getManageableRoles(authorRoles) {
  return new Set(authorRoles);
  const allowedRolesToManage = new Set();

  for (const managerRoleId of authorRoles) {
    const manageableRoles = config.rolePermissions?.[managerRoleId];
    if (manageableRoles) {
      manageableRoles.forEach(id => allowedRolesToManage.add(id));
    }
  }
}
/**
 * helper function
 * @param {Message} message 
 * @param {string} content 
 * @param {string|number} color 
 * @returns 
 */
function basicEmbedReply(message, content, color) {
  const embed = new EmbedBuilder()
    .setColor(color ?? 0x7AE582)
    .setDescription(
      content
    )
    .setTimestamp();
  return message.reply({ embeds: [embed] })
}

function getMemberFromString(guild, member) {
  match = MEMBER_REGEX.exec(member);
  return guild.members.cache.get(match?.[1]);
}

/**
 * @param {Message} message
 * @param {string[]} args
 * @param {"add" | "remove"} action The action to do ("add" or "remove").
 */
async function handleRoleCommand(message, args, action) {
  const targetMember = getMemberFromString(args[0]);

  const roleIdentifier = args.slice(1).join(" ").trim();

  if (!targetMember) {
    return basicEmbedReply(message, `Please specify a member or member ID. Usage: \`${config.prefix}role${action} [@user] <role name/id>\``);
  }
  
  if (!roleIdentifier) {
    return basicEmbedReply(message, `Please specify a role name or ID. Usage: \`${config.prefix}role${action} [@user] <role name/id>\``);
  }

  const role = message.guild.roles.cache.find(r => r.name.toLowerCase() === roleIdentifier.toLowerCase() || r.id === roleIdentifier);

  if (role === undefined) {
    return basicEmbedReply(message, `Could not find a role with the name or ID: \`${roleIdentifier}\`.`, 0x690202);
  }

  const allowedRolesToManage = getManageableRoles(message.member.roles.cache.map(r => r.id)); // get the roles the author has permissions to manage

  if (!allowedRolesToManage.has(role.id)) {
    return basicEmbedReply(message, `You are not permitted to manage the **${role.name}** role.`);
  }

  try {
    if (action === "add") {
      if (targetMember.roles.cache.has(role.id)) {
        return basicEmbedReply(message, `${targetMember.displayName} already has the **${role.name}** role.`);
      }
      await targetMember.roles.add(role);
      await basicEmbedReply(message, `Successfully added the **${role.name}** role to ${targetMember.displayName}.`);
      
    } else if (action === "remove") {
      if (!targetMember.roles.cache.has(role.id)) {
        return basicEmbedReply(message, `${targetMember.displayName} does not have the **${role.name}** role.`);
      }
      await targetMember.roles.remove(role);
      await basicEmbedReply(message, `Successfully removed the **${role.name}** role from ${targetMember.displayName}.`);

    }
  } catch (error) {
    console.error(`Failed to ${action} role:`, error);
    basicEmbedReply(message, `I was unable to ${action} the role. Make sure my role is higher than the **${role.name}** role in the server roles or that it exists!`, 0x690202);
  }
}

const addRoleCommand = (message, args, config) => handleRoleCommand(message, args, "add", config)
const removeRoleCommand = (message, args, config) => handleRoleCommand(message, args, "remove", config);

const commandFunctions = {
  "roleadd": addRoleCommand,
  "roleremove": removeRoleCommand,
  "ra": addRoleCommand,
  "rr": removeRoleCommand
};


/**
 * @param {Message} message
 */
function processCommand(message) {
  if (!message.guild || !config.prefix || !message.content.startsWith(config.prefix)) {
    return;
  }

  const args = message.content.slice(config.prefix.length).trim().split(/ +/);
  const commandName = args.shift().toLowerCase();

  const command = commandFunctions[commandName];

  if (command) {
    try {
      command(message, args);
    } catch (error) {
      console.error(`Error executing command ${commandName}:`, error);
      message.reply("An error occurred while trying to execute that command.");
    }
  }
}


client.login(process.env.DISCORD_TOKEN);
