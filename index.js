import { 
  Client, GatewayIntentBits, REST, Routes, PermissionFlagsBits, EmbedBuilder 
} from "discord.js";
import mqtt from "mqtt";
import fs from "fs";
import dotenv from "dotenv";
import { DateTime } from "luxon";

dotenv.config();

// ===== CONFIG =====
const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

const mqttServer = process.env.MQTT_SERVER;
const mqttUser = process.env.MQTT_USER;
const mqttPass = process.env.MQTT_PASS;

const topicTemp = "aiot/namuen/temp";
const topicHum = "aiot/namuen/hum";

// ===== โหลด/บันทึก Config =====
const configFile = "./config.json";
let config = { logChannelId: null, alertChannelId: null, tempThreshold: 30 };

if (fs.existsSync(configFile)) {
  try {
    const fileData = fs.readFileSync(configFile, "utf8");
    if (fileData.trim() !== "") {
      config = JSON.parse(fileData);
    } else {
      fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    }
  } catch (err) {
    console.error("❌ config.json ว่างหรือเสีย กำลังสร้างใหม่...");
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  }
} else {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

function saveConfig() {
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
}

// ===== Discord Client =====
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

// ===== Slash Commands =====
const commands = [
  { name: "status", description: "ดูสถานะอุณหภูมิและความชื้นล่าสุด" },
  { name: "setlogchannel", description: "ตั้งค่าช่องสำหรับบันทึก log", default_member_permissions: PermissionFlagsBits.Administrator.toString() },
  { name: "setalertchannel", description: "ตั้งค่าช่องสำหรับแจ้งเตือนเมื่ออุณหภูมิสูงเกิน", default_member_permissions: PermissionFlagsBits.Administrator.toString() },
  { 
    name: "setthreshold", 
    description: "ตั้งค่าอุณหภูมิที่ต้องการให้แจ้งเตือน",
    options: [{ name: "temperature", description: "อุณหภูมิ (°C)", type: 4, required: true }],
    default_member_permissions: PermissionFlagsBits.Administrator.toString(),
  }
];

const rest = new REST({ version: "10" }).setToken(token);

(async () => {
  try {
    console.log("⏳ สมัคร Slash Commands...");
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log("✅ สมัคร Slash Commands เสร็จแล้ว");
  } catch (error) {
    console.error(error);
  }
})();

// ===== MQTT Connect =====
const mqttClient = mqtt.connect(mqttServer, { username: mqttUser, password: mqttPass });

let latestTemp = null;
let latestHum = null;
let lastUpdateTime = null;

let alertSent = false;       // แจ้งเตือนอุณหภูมิสูงเกินครั้งแรก
let fireAlertSent = false;   // แจ้งเตือนไฟไหม้ (10 นาที)
let highTempStart = null;    // เวลาเริ่มอุณหภูมิสูงเกิน threshold
let logPending = false;      // กัน log ซ้ำ

mqttClient.on("connect", () => {
  console.log("✅ MQTT Connected");
  mqttClient.subscribe([topicTemp, topicHum], (err) => {
    if (!err) console.log("📡 Subscribed:", topicTemp, topicHum);
  });
});

mqttClient.on("message", (topic, message) => {
  const value = parseFloat(message.toString());
  const now = DateTime.now().setZone("Asia/Bangkok");

  if (topic === topicTemp) latestTemp = value;
  if (topic === topicHum) latestHum = value;
  lastUpdateTime = now;

  // แจ้งเตือนอุณหภูมิสูงเกิน threshold
  if (config.alertChannelId && topic === topicTemp && latestTemp > config.tempThreshold) {
    const alertChannel = client.channels.cache.get(config.alertChannelId);

    if (alertChannel && !alertSent) {
      const alertEmbed = new EmbedBuilder()
        .setColor(0xff0000)
        .setTitle("🚨 อุณหภูมิสูงเกินไป!")
        .setDescription(`อุณหภูมิปัจจุบัน **${latestTemp}°C** สูงกว่าเกณฑ์ที่ตั้งไว้ (**${config.tempThreshold}°C**)`)
        .setFooter({ text: `เวลาแจ้งเตือน: ${now.toLocaleString(DateTime.DATETIME_MED)}` });
      alertChannel.send({ embeds: [alertEmbed] });
      alertSent = true;
    }

    // เริ่มจับเวลาอุณหภูมิสูงติดต่อกัน
    if (!highTempStart) {
      highTempStart = now;
    } else {
      const diffMinutes = now.diff(highTempStart, "minutes").minutes;
      if (diffMinutes >= 10 && !fireAlertSent) {
        const fireEmbed = new EmbedBuilder()
          .setColor(0xff6600)
          .setTitle("🔥 เตือนภัยไฟไหม้!")
          .setDescription(`อุณหภูมิเกิน ${config.tempThreshold}°C ติดต่อกัน **10 นาที**\nอาจมีความเสี่ยงเกิดไฟไหม้ โปรดตรวจสอบพื้นที่ทันที!`)
          .setFooter({ text: `เวลาแจ้งเตือน: ${now.toLocaleString(DateTime.DATETIME_MED)}` });
        alertChannel.send({ embeds: [fireEmbed] });
        fireAlertSent = true;
      }
    }
  }

  // รีเซ็ตสถานะเมื่ออุณหภูมิต่ำกว่าหรือเท่ากับ threshold
  if (topic === topicTemp && latestTemp <= config.tempThreshold) {
    alertSent = false;
    fireAlertSent = false;
    highTempStart = null;
  }

  // ส่ง log ทุก 1 วิ รวม temp+hum (ถ้ามี logChannel ตั้งไว้)
  if (config.logChannelId && !logPending) {
    logPending = true;

    setTimeout(() => {
      if (latestTemp !== null || latestHum !== null) {
        const logChannel = client.channels.cache.get(config.logChannelId);
        if (logChannel) {
          const logEmbed = new EmbedBuilder()
            .setColor(0x3498db)
            .setTitle("📡 Log ข้อมูลจาก ESP32")
            .addFields(
              { name: "🌡 อุณหภูมิ", value: latestTemp !== null ? `${latestTemp} °C` : "-", inline: true },
              { name: "💧 ความชื้น", value: latestHum !== null ? `${latestHum} %` : "-", inline: true },
            )
            .setFooter({ text: `อัปเดตเมื่อ: ${now.toLocaleString(DateTime.DATETIME_MED)}` });

          logChannel.send({ embeds: [logEmbed] });
        }
      }
      logPending = false;
    }, 1000);
  }
});

// ===== Discord Event =====
client.on("ready", () => {
  console.log(`✅ บอทล็อกอินแล้วเป็น: ${client.user.tag}`);
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "status") {
    if (latestTemp === null || latestHum === null) {
      await interaction.reply("❌ ยังไม่ได้รับข้อมูลจาก ESP32");
    } else {
      const embed = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("📊 สถานะล่าสุด")
        .addFields(
          { name: "🌡 อุณหภูมิ", value: `${latestTemp} °C`, inline: true },
          { name: "💧 ความชื้น", value: `${latestHum} %`, inline: true },
        )
        .setFooter({ text: `อัปเดตเมื่อ: ${lastUpdateTime.toLocaleString(DateTime.DATETIME_MED)}` });
      await interaction.reply({ embeds: [embed] });
    }
  }

  if (interaction.commandName === "setlogchannel") {
    config.logChannelId = interaction.channelId;
    saveConfig();
    await interaction.reply(`✅ ตั้งค่าช่อง **Log** เป็น <#${interaction.channelId}> แล้ว`);
  }

  if (interaction.commandName === "setalertchannel") {
    config.alertChannelId = interaction.channelId;
    saveConfig();
    await interaction.reply(`✅ ตั้งค่าช่อง **Alert** เป็น <#${interaction.channelId}> แล้ว`);
  }

  if (interaction.commandName === "setthreshold") {
    const newThreshold = interaction.options.getInteger("temperature");
    config.tempThreshold = newThreshold;
    saveConfig();
    await interaction.reply(`✅ ตั้งค่าแจ้งเตือนอุณหภูมิเป็น **${newThreshold}°C** แล้ว`);
  }
});

// ===== Login Bot =====
client.login(token);
