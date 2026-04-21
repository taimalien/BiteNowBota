const express = require("express");
const axios   = require("axios");
const crypto  = require("crypto");

const app = express();
app.use(express.json());

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN     = process.env.BOT_TOKEN;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID || "6408550462";
const TELEGRAM_API  = `https://api.telegram.org/bot${BOT_TOKEN}`;

const CREDITS_PER_REFERRAL  = 3;
const CREDITS_FOR_FREE_ORDER = 6;
const FIRST_ORDER_DISCOUNT   = "70%";
const REPEAT_ORDER_DISCOUNT  = "65%";

const STAGE = Object.freeze({
  IDLE:            "idle",
  WAITING_CART:    "waiting_cart",
  WAITING_ADDRESS: "waiting_address",
  WAITING_PHONE:   "waiting_phone",
  WAITING_EMAIL:   "waiting_email",
  WAITING_PAYMENT: "waiting_payment",
  DONE:            "done",
});

const ADDRESS_STEP = Object.freeze({
  STREET: "street",
  APT:    "apt",
  CITY:   "city",
  STATE:  "state",
  ZIP:    "zip",
});

const SKIP_WORDS = new Set(["-", "--", "none", "skip", "na", "n/a", "no"]);

// ─── In-memory stores ─────────────────────────────────────────────────────────

let orderCounter = 1487;
const sessions         = {};
const users            = {};
const creditKeys       = {};
const processedUpdates = new Set();

// ─── Maps ─────────────────────────────────────────────────────────────────────

const RESTAURANT_MAP = {
  // Pizza
  rest_dominos:       "Domino's",
  rest_papajohns:     "Papa John's",
  rest_modpizza:      "Mod Pizza",
  // Fast Food
  rest_subway:        "Subway",
  rest_jackinthebox:  "Jack in the Box",
  rest_sonic:         "Sonic",
  rest_freddys:       "Freddy's Steakburgers",
  rest_shakeshack:    "Shake Shack",
  rest_steaknshake:   "Steak 'n Shake",
  rest_buffalowild:   "Buffalo Wild Wings",
  rest_wingeats:      "WINGEATS",
  rest_hangryjoes:    "Hangry Joe's",
  // Chicken
  rest_churchs:       "Church's Chicken",
  // Asian
  rest_panda:         "Panda Express",
  rest_85c:           "85°C Bakery Cafe",
  rest_lotus:         "Lotus Seafood",
  // Casual Dining
  rest_applebees:     "Applebee's",
  rest_olivegarden:   "Olive Garden",
  rest_crackerbarrel: "Cracker Barrel",
  rest_bjsbrewhouse:  "BJ's Brewhouse",
  rest_cheesecake:    "The Cheesecake Factory",
  rest_charleys:      "Charley's",
  // Sandwiches & Subs
  rest_jerseymikes:   "Jersey Mike's",
  // Smoothies & Juice
  rest_smoothieking:  "Smoothie King",
  rest_tropicalsmoothie: "Tropical Smoothie Cafe",
  rest_jamba:         "Jamba Juice",
  // Bakery & Café
  rest_panera:        "Panera Bread",
  rest_shipleys:      "Shipley Do-Nuts",
  rest_insomnia:      "Insomnia Cookies",
  rest_auntie:        "Auntie Anne's",
  // Other
  rest_clover:        "CLOVER",
  rest_slicelife:     "SliceLife",
  rest_menufy:        "MENUFY",
  rest_square:        "SQUARE",
};

const PAYMENT_MAP = {
  pay_cashapp:  "CashApp",
  pay_applepay: "Apple Pay",
  pay_zelle:    "Zelle",
  pay_crypto:   "Crypto",
};

// ─── User & session helpers ───────────────────────────────────────────────────

function generateOrderId() {
  return `ORD-${++orderCounter}`;
}

function generateCreditKey() {
  const part = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `BITE-${part()}-${part()}`;
}

function getUser(chatId) {
  if (!users[chatId]) {
    users[chatId] = {
      credits:    0,
      referredBy: null,
      hasOrdered: false,
      refCode:    `REF${chatId}`,
    };
  }
  return users[chatId];
}

function findUserByRefCode(code) {
  const entry = Object.entries(users).find(([, u]) => u.refCode === code);
  return entry ? { chatId: entry[0], user: entry[1] } : null;
}

function getSession(chatId) {
  if (!sessions[chatId]) sessions[chatId] = buildFreshSession();
  return sessions[chatId];
}

function buildFreshSession() {
  return {
    stage:              STAGE.IDLE,
    cartFileId:         null,
    address:            null,
    addressLine2:       null,
    city:               null,
    state:              null,
    zip:                null,
    fullAddress:        null,
    phone:              null,
    email:              null,
    username:           null,
    addressStep:        ADDRESS_STEP.STREET,
    paymentMethod:      null,
    orderId:            null,
    selectedRestaurant: null,
  };
}

function resetSession(chatId) {
  const username     = sessions[chatId]?.username ?? null;
  sessions[chatId]   = buildFreshSession();
  sessions[chatId].stage    = STAGE.WAITING_CART;
  sessions[chatId].username = username;
  return sessions[chatId];
}

// ─── Telegram helpers ─────────────────────────────────────────────────────────

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function telegramPost(method, payload, retries = 2) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await axios.post(`${TELEGRAM_API}/${method}`, payload);
      return res.data;
    } catch (err) {
      if (attempt === retries) {
        console.error(`Telegram ${method} failed:`, err?.response?.data ?? err.message);
        return null;
      }
      await delay(500 * (attempt + 1));
    }
  }
}

async function sendTyping(chatId) {
  await telegramPost("sendChatAction", { chat_id: chatId, action: "typing" });
}

async function send(chatId, text, extra = {}) {
  await sendTyping(chatId);
  await delay(300);
  await telegramPost("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...extra,
  });
  await delay(100);
}

async function sendWithButtons(chatId, text, inline_keyboard) {
  await sendTyping(chatId);
  await delay(300);
  await telegramPost("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard },
  });
  await delay(100);
}

async function answerCallback(id) {
  await telegramPost("answerCallbackQuery", { callback_query_id: id });
}

// ─── Bot UI ───────────────────────────────────────────────────────────────────

function sendPaymentButtons(chatId) {
  return sendWithButtons(chatId, "◆ Select your payment method:", [
    [{ text: "CashApp",   callback_data: "pay_cashapp"  }, { text: "Apple Pay", callback_data: "pay_applepay" }],
    [{ text: "Zelle",     callback_data: "pay_zelle"    }, { text: "Crypto",    callback_data: "pay_crypto"   }],
  ]);
}

function sendRestaurantMenu(chatId) {
  return sendWithButtons(chatId, "◆ Select a restaurant or just send your cart screenshot:", [
    // Pizza
    [{ text: "Domino's",              callback_data: "rest_dominos"       }, { text: "Papa John's",       callback_data: "rest_papajohns"    }],
    [{ text: "Mod Pizza",             callback_data: "rest_modpizza"      }],
    // Fast Food
    [{ text: "Subway",                callback_data: "rest_subway"        }, { text: "Jack in the Box",   callback_data: "rest_jackinthebox" }],
    [{ text: "Sonic",                 callback_data: "rest_sonic"         }, { text: "Freddy's",          callback_data: "rest_freddys"      }],
    [{ text: "Shake Shack",           callback_data: "rest_shakeshack"    }, { text: "Steak 'n Shake",    callback_data: "rest_steaknshake"  }],
    [{ text: "Buffalo Wild Wings",    callback_data: "rest_buffalowild"   }, { text: "WINGEATS",          callback_data: "rest_wingeats"     }],
    [{ text: "Hangry Joe's",          callback_data: "rest_hangryjoes"    }, { text: "Church's Chicken",  callback_data: "rest_churchs"      }],
    // Sandwiches
    [{ text: "Jersey Mike's",         callback_data: "rest_jerseymikes"   }, { text: "Charley's",         callback_data: "rest_charleys"     }],
    // Asian
    [{ text: "Panda Express",         callback_data: "rest_panda"         }, { text: "85°C Bakery",       callback_data: "rest_85c"          }],
    [{ text: "Lotus Seafood",         callback_data: "rest_lotus"         }],
    // Casual Dining
    [{ text: "Applebee's",            callback_data: "rest_applebees"     }, { text: "Olive Garden",      callback_data: "rest_olivegarden"  }],
    [{ text: "Cracker Barrel",        callback_data: "rest_crackerbarrel" }, { text: "BJ's Brewhouse",    callback_data: "rest_bjsbrewhouse" }],
    [{ text: "Cheesecake Factory",    callback_data: "rest_cheesecake"    }],
    // Smoothies
    [{ text: "Smoothie King",         callback_data: "rest_smoothieking"  }, { text: "Tropical Smoothie", callback_data: "rest_tropicalsmoothie" }],
    [{ text: "Jamba Juice",           callback_data: "rest_jamba"         }],
    // Bakery & Café
    [{ text: "Panera Bread",          callback_data: "rest_panera"        }, { text: "Shipley Do-Nuts",   callback_data: "rest_shipleys"     }],
    [{ text: "Insomnia Cookies",      callback_data: "rest_insomnia"      }, { text: "Auntie Anne's",     callback_data: "rest_auntie"       }],
    // Other
    [{ text: "SliceLife",             callback_data: "rest_slicelife"     }, { text: "CLOVER",            callback_data: "rest_clover"       }],
    [{ text: "MENUFY",                callback_data: "rest_menufy"        }, { text: "SQUARE",            callback_data: "rest_square"       }],
  ]);
}

// ─── Owner notifications ──────────────────────────────────────────────────────

async function notifyOwner(chatId, username, label, content) {
  if (chatId === OWNER_CHAT_ID) return;
  await telegramPost("sendMessage", {
    chat_id: OWNER_CHAT_ID,
    text: `— ${username} (${chatId})\n[${label}]: ${content}\n\n/reply ${chatId} your message`,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  });
}

async function notifyOwnerPhoto(chatId, username, fileId, label) {
  if (chatId === OWNER_CHAT_ID) return;
  await telegramPost("sendPhoto", {
    chat_id: OWNER_CHAT_ID,
    photo: fileId,
    caption: `— ${username} (${chatId})\n[${label}]\n\n/reply ${chatId} your message`,
  });
}

async function notifyOwnerOrder(session, chatId, user) {
  const freeNote  = user.credits >= CREDITS_FOR_FREE_ORDER ? "\nFREE ORDER — credits applied\n" : "";
  const firstNote = !user.hasOrdered ? "\n◆ FIRST ORDER — 70% off\n" : "";
  const caption =
    `— NEW ORDER —\n\n` +
    `Order ID: ${session.orderId}\n` +
    `Customer: ${session.username || chatId}\n` +
    `Restaurant: ${session.selectedRestaurant || "Not selected"}\n` +
    `Address: ${session.fullAddress}\n` +
    `Phone: ${session.phone}\n` +
    `Email: ${session.email}\n` +
    `Payment: ${session.paymentMethod}\n` +
    `Credits: ${user.credits}${freeNote}${firstNote}\n\n` +
    `t.me/${session.username?.replace("@", "") || chatId}\n` +
    `/reply ${chatId} your message`;

  if (session.cartFileId) {
    await telegramPost("sendPhoto", { chat_id: OWNER_CHAT_ID, photo: session.cartFileId, caption });
  } else {
    await telegramPost("sendMessage", { chat_id: OWNER_CHAT_ID, text: caption });
  }
}

// ─── Static content ───────────────────────────────────────────────────────────

const MENU_TEXT = `◆ BiteNow — Restaurant Menu

━━━━━━━━━━━━━━━━━━
◇ PIZZA
━━━━━━━━━━━━━━━━━━
◦ Domino's
◦ Papa John's
◦ Mod Pizza

━━━━━━━━━━━━━━━━━━
◇ FAST FOOD
━━━━━━━━━━━━━━━━━━
◦ Subway
◦ Jack in the Box
◦ Sonic
◦ Freddy's Steakburgers
◦ Shake Shack
◦ Steak 'n Shake
◦ Buffalo Wild Wings
◦ WINGEATS
◦ Hangry Joe's
◦ Church's Chicken

━━━━━━━━━━━━━━━━━━
◇ SANDWICHES
━━━━━━━━━━━━━━━━━━
◦ Jersey Mike's
◦ Charley's

━━━━━━━━━━━━━━━━━━
◇ ASIAN
━━━━━━━━━━━━━━━━━━
◦ Panda Express
◦ 85°C Bakery Cafe
◦ Lotus Seafood

━━━━━━━━━━━━━━━━━━
◇ CASUAL DINING
━━━━━━━━━━━━━━━━━━
◦ Applebee's
◦ Olive Garden
◦ Cracker Barrel
◦ BJ's Brewhouse
◦ The Cheesecake Factory

━━━━━━━━━━━━━━━━━━
◇ SMOOTHIES & JUICE
━━━━━━━━━━━━━━━━━━
◦ Smoothie King
◦ Tropical Smoothie Cafe
◦ Jamba Juice

━━━━━━━━━━━━━━━━━━
◇ BAKERY & CAFÉ
━━━━━━━━━━━━━━━━━━
◦ Panera Bread
◦ Shipley Do-Nuts
◦ Insomnia Cookies
◦ Auntie Anne's

━━━━━━━━━━━━━━━━━━
◇ OTHER
━━━━━━━━━━━━━━━━━━
◦ SliceLife
◦ CLOVER
◦ MENUFY
◦ SQUARE
◦ + more added regularly

━━━━━━━━━━━━━━━━━━
◆ First order → 70% off
◆ Every order after → 65% off
◆ 6 referral credits → free order
━━━━━━━━━━━━━━━━━━

Ready? Send your cart screenshot.`;

const FAQ = [
  { keys: ["how", "work", "works"],
    reply: "◆ You send the cart. We place the order. You pay less.\n\nFirst order is 70% off. No catch." },
  { keys: ["save", "65", "70", "percent", "discount"],
    reply: "◆ First order — 70% off.\n◆ Every order after — 65% off." },
  { keys: ["pay", "payment", "cost", "price"],
    reply: "◆ You pay after the order is confirmed.\n\nCashApp ◇ Apple Pay ◇ Zelle ◇ Crypto" },
  { keys: ["restaurant", "restaurants", "where", "place", "which", "menu"],
    reply: "◆ Type /menu to see every restaurant we cover." },
  { keys: ["long", "fast", "time", "quick", "wait"],
    reply: "◆ Order goes in, we move. No delays on our end." },
  { keys: ["real", "legit", "scam", "trust", "safe", "fake"],
    reply: "◆ BiteNow doesn't miss.\n\nEvery order placed. Every customer saves." },
  { keys: ["refer", "referral", "invite", "link", "credits", "credit", "free"],
    reply: "◆ Type /referral to get your link.\n\nEvery person you bring in who orders → 3 credits.\n6 credits → free order." },
  { keys: ["redeem", "key", "code"],
    reply: "◆ Got a credit key? Use /redeem YOUR-KEY to apply it." },
  { keys: ["hi", "hey", "hello", "sup", "yo", "hii", "heyy", "helo", "wsg", "wsp"],
    reply: "◆ Welcome to BiteNow.\n\nFirst order is 70% off. Send your cart screenshot and we handle the rest." },
];

function getScriptedReply(text) {
  const lower = text.toLowerCase();
  for (const faq of FAQ) {
    if (faq.keys.some((k) => lower.includes(k))) return faq.reply;
  }
  return "◆ Send your cart screenshot and we'll take it from there.";
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleStart(chatId, session, user, text) {
  const parts   = text.split(" ");
  const refCode = parts[1] || null;

  if (refCode && !user.referredBy) {
    const referrer = findUserByRefCode(refCode);
    if (referrer && referrer.chatId !== chatId) {
      user.referredBy = referrer.chatId;
      await telegramPost("sendMessage", {
        chat_id: referrer.chatId,
        text: `◆ Someone just joined using your referral link.\n\nYou'll get 3 credits when they place their first order.`,
        parse_mode: "HTML",
      });
    }
  }

  resetSession(chatId);
  getSession(chatId).username = session.username;

  await notifyOwner(chatId, session.username, "SESSION STARTED", "/start");
  await send(chatId, "◆ Welcome to BiteNow.");
  await sendRestaurantMenu(chatId);
}

async function handleMenu(chatId, session) {
  await notifyOwner(chatId, session.username, "COMMAND", "/menu");
  await send(chatId, MENU_TEXT);
  await sendRestaurantMenu(chatId);
}

async function handleReferral(chatId, session, user) {
  const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
  await notifyOwner(chatId, session.username, "COMMAND", "/referral");
  await send(chatId,
    `◆ Your referral link:\nt.me/BiteNowBot?start=${user.refCode}\n\n` +
    `◇ Share this link — when someone joins and places their first order you get 3 credits\n` +
    `◇ 6 credits = your next order is completely free\n\n` +
    `Your credits: ${user.credits}\n` +
    `Credits needed for free order: ${needed}`
  );
}

async function handleCredits(chatId, session, user) {
  const needed = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
  await notifyOwner(chatId, session.username, "COMMAND", "/credits");
  if (user.credits >= CREDITS_FOR_FREE_ORDER) {
    await send(chatId, `◆ You have ${user.credits} credits.\n\nYour next order is free. Place it and we'll apply them.`);
  } else {
    await send(chatId, `◆ You have ${user.credits} credits.\n\n${needed} more and your next order is on us.\n\n/referral`);
  }
}

async function handleRedeem(chatId, session, user, text) {
  const key = text.split(" ")[1]?.toUpperCase().trim();
  await notifyOwner(chatId, session.username, "REDEEM ATTEMPT", key || "(no key)");

  if (!key) {
    await send(chatId, "◆ Usage: /redeem YOUR-KEY\n\nExample: /redeem BITE-A3F2-9K1X");
    return;
  }

  const keyData = creditKeys[key];

  if (!keyData) {
    await send(chatId, "◆ That key doesn't exist. Double-check it and try again.");
    return;
  }
  if (keyData.usedBy) {
    await send(chatId, "◆ That key has already been redeemed.");
    return;
  }

  keyData.usedBy  = chatId;
  user.credits   += keyData.credits;

  await notifyOwner(chatId, session.username, "KEY REDEEMED", `${key} → +${keyData.credits} credits`);

  const needed  = Math.max(0, CREDITS_FOR_FREE_ORDER - user.credits);
  const freeMsg = user.credits >= CREDITS_FOR_FREE_ORDER
    ? `\n\nYour next order is free. Place it whenever.`
    : `\n\n${needed} more credits until your free order.`;

  await send(chatId,
    `◆ Key redeemed.\n\n` +
    `◇ +${keyData.credits} credits added\n` +
    `◇ Total credits: ${user.credits}` +
    freeMsg
  );
}

async function handleCartPhoto(chatId, session, fileId) {
  session.cartFileId  = fileId;
  session.stage       = STAGE.WAITING_ADDRESS;
  session.addressStep = ADDRESS_STEP.STREET;
  await notifyOwnerPhoto(chatId, session.username, fileId, "CART SCREENSHOT");
  await send(chatId, "◆ Received.\n\nLet's get your details locked in.");
  await send(chatId, "Street Address:");
}

async function handleAddress(chatId, session, text) {
  switch (session.addressStep) {
    case ADDRESS_STEP.STREET:
      session.address     = text;
      session.addressStep = ADDRESS_STEP.APT;
      await send(chatId, "Apt or Unit # (type - to skip):");
      break;

    case ADDRESS_STEP.APT:
      session.addressLine2 = SKIP_WORDS.has(text.toLowerCase()) ? null : text;
      session.addressStep  = ADDRESS_STEP.CITY;
      await send(chatId, "City:");
      break;

    case ADDRESS_STEP.CITY:
      session.city        = text;
      session.addressStep = ADDRESS_STEP.STATE;
      await send(chatId, "State:");
      break;

    case ADDRESS_STEP.STATE:
      session.state       = text;
      session.addressStep = ADDRESS_STEP.ZIP;
      await send(chatId, "ZIP Code:");
      break;

    case ADDRESS_STEP.ZIP: {
      if (!/^\d{5,6}$/.test(text)) {
        await send(chatId, "Enter a valid ZIP code:");
        return;
      }
      session.zip = text;
      const apt   = session.addressLine2 ? `, ${session.addressLine2}` : "";
      session.fullAddress = `${session.address}${apt}, ${session.city}, ${session.state} ${session.zip}`;
      session.stage       = STAGE.WAITING_PHONE;
      await send(chatId, "◆ Got it.\n\nPhone Number:");
      break;
    }
  }
}

async function handleRestaurantCallback(chatId, session, username, data) {
  const chosen = RESTAURANT_MAP[data];
  if (!chosen) return;

  session.selectedRestaurant = chosen;
  await notifyOwner(chatId, username, "SELECTED RESTAURANT", chosen);
  await telegramPost("sendMessage", {
    chat_id: OWNER_CHAT_ID,
    text: `— ${username} (${chatId})\n[WAITING FOR CART]: ${chosen}\n\nAbout to send cart screenshot.`,
    parse_mode: "HTML",
  });

  if (session.stage === STAGE.WAITING_CART) {
    await send(chatId, `◆ ${chosen} — noted.\n\nNow send your cart screenshot to continue.`);
  }
}

async function handlePaymentCallback(chatId, session, user, username, data) {
  const chosen = PAYMENT_MAP[data];
  if (!chosen) return;

  session.paymentMethod = chosen;

  const isFreeOrder  = user.credits >= CREDITS_FOR_FREE_ORDER;
  const isFirstOrder = !user.hasOrdered;
  session.orderId    = generateOrderId();

  await notifyOwner(chatId, username, "PAYMENT METHOD", chosen);

  if (isFirstOrder && user.referredBy) {
    const referrer    = getUser(user.referredBy);
    referrer.credits += CREDITS_PER_REFERRAL;
    const refNeeded   = Math.max(0, CREDITS_FOR_FREE_ORDER - referrer.credits);
    const refMsg      = referrer.credits >= CREDITS_FOR_FREE_ORDER
      ? "Your next order is free. Use it whenever."
      : `${refNeeded} more credits until your free order.`;
    await telegramPost("sendMessage", {
      chat_id: user.referredBy,
      text: `◆ Someone you referred just placed their first order.\n\n◇ +${CREDITS_PER_REFERRAL} credits added. Total: ${referrer.credits}\n\n${refMsg}`,
      parse_mode: "HTML",
    });
  }

  user.hasOrdered = true;
  if (isFreeOrder) user.credits -= CREDITS_FOR_FREE_ORDER;

  const discountLine = isFreeOrder
    ? "◇ This one is on us — credits applied."
    : isFirstOrder
    ? `◇ First order bonus — ${FIRST_ORDER_DISCOUNT} off applied.\n◇ Every order after this is ${REPEAT_ORDER_DISCOUNT} off.`
    : `◇ ${REPEAT_ORDER_DISCOUNT} off applied.`;

  await send(chatId,
    `◆ Order Submitted\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `Order ID: ${session.orderId}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `Restaurant: ${session.selectedRestaurant || "Not selected"}\n` +
    `Name: ${username}\n` +
    `Address: ${session.fullAddress}\n` +
    `Phone: ${session.phone}\n` +
    `Payment: ${chosen}\n\n` +
    `━━━━━━━━━━━━━━━━━━\n` +
    `${discountLine}\n` +
    `━━━━━━━━━━━━━━━━━━\n\n` +
    `We will reach out shortly with payment details.\n\n` +
    `◆ Refer friends and earn free orders:\n` +
    `Every person you invite who orders earns you 3 credits.\n` +
    `6 credits = your next order is completely free.\n\n` +
    `Your link:\nt.me/BiteNowBot?start=${user.refCode}`
  );

  await notifyOwnerOrder(session, chatId, user);
  resetSession(chatId);
}

// ─── Webhook ──────────────────────────────────────────────────────────────────

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);

  const body     = req.body;
  const updateId = body?.update_id;

  if (updateId !== undefined) {
    if (processedUpdates.has(updateId)) return;
    processedUpdates.add(updateId);
    if (processedUpdates.size > 5000) {
      const oldest = [...processedUpdates].slice(0, 1000);
      oldest.forEach((id) => processedUpdates.delete(id));
    }
  }

  try {
    const callbackQuery = body?.callback_query;
    const msg           = body?.message;
    if (callbackQuery) await handleCallbackQuery(callbackQuery);
    else if (msg)      await handleMessage(msg);
  } catch (err) {
    console.error("Webhook error:", err?.message, err?.stack);
  }
});

async function handleCallbackQuery(callbackQuery) {
  const chatId   = String(callbackQuery.message.chat.id);
  const data     = callbackQuery.data;
  const session  = getSession(chatId);
  const user     = getUser(chatId);
  const username = callbackQuery.from?.username
    ? `@${callbackQuery.from.username}`
    : callbackQuery.from?.first_name || chatId;

  await answerCallback(callbackQuery.id);

  if (data.startsWith("rest_"))     await handleRestaurantCallback(chatId, session, username, data);
  else if (data.startsWith("pay_")) await handlePaymentCallback(chatId, session, user, username, data);
}

async function handleMessage(msg) {
  const chatId  = String(msg.chat.id);
  const text    = (msg.text || "").trim();
  const photo   = msg.photo;
  const session = getSession(chatId);
  const user    = getUser(chatId);

  session.username = msg.from?.username
    ? `@${msg.from.username}`
    : msg.from?.first_name || chatId;

  // ── Owner-only commands ────────────────────────────────────────────────────
  if (chatId === OWNER_CHAT_ID) {

    if (text.startsWith("/reply ")) {
      const parts     = text.split(" ");
      const targetId  = parts[1];
      const replyText = parts.slice(2).join(" ");
      if (targetId && replyText && users[targetId]) {
        await send(targetId, replyText);
        await telegramPost("sendMessage", { chat_id: OWNER_CHAT_ID, text: `◆ Sent to ${targetId}.` });
      } else {
        await telegramPost("sendMessage", { chat_id: OWNER_CHAT_ID, text: `◆ Unknown user: ${targetId}` });
      }
    }

    if (text.startsWith("/announce ")) {
      const announcement = text.slice("/announce ".length).trim();
      if (!announcement) return;
      const allUserIds = Object.keys(users);
      if (allUserIds.length === 0) {
        await telegramPost("sendMessage", { chat_id: OWNER_CHAT_ID, text: "◆ No users to announce to yet." });
        return;
      }
      let sent = 0, failed = 0;
      for (const uid of allUserIds) {
        const result = await telegramPost("sendMessage", {
          chat_id: uid,
          text: announcement,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        });
        result ? sent++ : failed++;
        await delay(50);
      }
      await telegramPost("sendMessage", {
        chat_id: OWNER_CHAT_ID,
        text: `◆ Announcement sent.\n✓ ${sent} delivered  ✗ ${failed} failed`,
      });
    }

    if (text.startsWith("/genkey ")) {
      const amount = parseInt(text.split(" ")[1], 10);
      if (!amount || amount < 1) {
        await telegramPost("sendMessage", {
          chat_id: OWNER_CHAT_ID,
          text: "◆ Usage: /genkey <credits>\n\nExample: /genkey 6",
        });
        return;
      }
      const key           = generateCreditKey();
      creditKeys[key]     = { credits: amount, usedBy: null };
      const freeOrderNote = amount >= CREDITS_FOR_FREE_ORDER ? "\n(enough for a free order)" : "";
      await telegramPost("sendMessage", {
        chat_id: OWNER_CHAT_ID,
        text:
          `◆ Credit key generated\n\n` +
          `<code>${key}</code>\n\n` +
          `◇ Worth: ${amount} credits${freeOrderNote}\n` +
          `◇ One-time use\n\n` +
          `Send this key to the customer.\n` +
          `They redeem it with: /redeem ${key}`,
        parse_mode: "HTML",
      });
    }

    if (text === "/keys") {
      const all = Object.entries(creditKeys);
      if (all.length === 0) {
        await telegramPost("sendMessage", { chat_id: OWNER_CHAT_ID, text: "◆ No keys generated yet." });
        return;
      }
      const lines = all.map(([k, v]) => {
        const status = v.usedBy ? `✗ used by ${v.usedBy}` : "✓ available";
        return `<code>${k}</code> — ${v.credits} credits — ${status}`;
      });
      await telegramPost("sendMessage", {
        chat_id: OWNER_CHAT_ID,
        text: `◆ All keys (${all.length}):\n\n` + lines.join("\n"),
        parse_mode: "HTML",
      });
    }

    return;
  }

  // ── Customer commands ──────────────────────────────────────────────────────

  if (text.startsWith("/start"))                          { await handleStart(chatId, session, user, text); return; }
  if (text === "/menu")                                   { await handleMenu(chatId, session); return; }
  if (["/referral", "/refer", "/getlink"].includes(text)) { await handleReferral(chatId, session, user); return; }
  if (text === "/credits")                                { await handleCredits(chatId, session, user); return; }
  if (text.startsWith("/redeem"))                         { await handleRedeem(chatId, session, user, text); return; }

  if (text) await notifyOwner(chatId, session.username, "MSG", text);

  if (photo) {
    const fileId = photo[photo.length - 1].file_id;
    if (session.stage === STAGE.WAITING_CART) {
      await handleCartPhoto(chatId, session, fileId);
    } else {
      await notifyOwnerPhoto(chatId, session.username, fileId, "PHOTO");
      await send(chatId, "Type /start to begin your order.");
    }
    return;
  }

  if (session.stage === STAGE.WAITING_ADDRESS && text) { await handleAddress(chatId, session, text); return; }
  if (session.stage === STAGE.WAITING_PHONE && text) {
    session.phone = text;
    session.stage = STAGE.WAITING_EMAIL;
    await send(chatId, "◆ Got it.\n\nEmail Address:");
    return;
  }
  if (session.stage === STAGE.WAITING_EMAIL && text) {
    session.email = text;
    session.stage = STAGE.WAITING_PAYMENT;
    await send(chatId, "◆ Almost done.");
    await sendPaymentButtons(chatId);
    return;
  }

  if ([STAGE.IDLE, STAGE.WAITING_CART].includes(session.stage) && text) {
    await send(chatId, getScriptedReply(text));
    return;
  }
  if (session.stage === STAGE.WAITING_CART) {
    await send(chatId, "◇ Send your cart screenshot.");
  }
}

// ─── Setup & health ───────────────────────────────────────────────────────────

app.get("/setup", async (req, res) => {
  try {
    await telegramPost("setMyCommands", {
      commands: [
        { command: "start",    description: "Place an order — 70% off first order" },
        { command: "menu",     description: "See all restaurants we cover"          },
        { command: "referral", description: "Get your referral link"                },
        { command: "credits",  description: "Check your credit balance"             },
        { command: "redeem",   description: "Redeem a credit key"                   },
      ],
    });
    await telegramPost("setChatMenuButton", { menu_button: { type: "commands" } });
    res.send("Setup complete.");
  } catch {
    res.status(500).send("Setup failed.");
  }
});

app.get("/", (req, res) => res.send("@BiteNowBot is live"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`@BiteNowBot running on port ${PORT}`));
