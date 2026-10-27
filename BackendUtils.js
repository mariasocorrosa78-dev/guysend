const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Console = require("./ConsoleUtils");
const dotenv = require('dotenv');
dotenv.config();
const CryptoUtils = require("./CryptoUtils");

const SharedUtils = require("./SharedUtils.js");
const SharedData = require("./shared.json");

function deepClone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeCurrencyName(currency) {
  if (!currency) return currency;
  const value = String(currency).trim();
  const lower = value.toLowerCase();
  const map = {
    gems: "gems",
    gem: "gems",
    gold: "coins",
    coins: "coins",
    coin: "coins",
    dust: "dust",
    aec: "aec",
    aes: "aes",
    freespins: "default_free_spins",
    adspins: "default_free_ad_spins",
    default_free_spins: "default_free_spins",
    default_free_ad_spins: "default_free_ad_spins",
    stumble_coins: "stumble_coins",
    video_coins: "video_coins",
    video_gems: "video_gems"
  };
  return map[lower] || lower;
}

function getItemPrices(item) {
  return item?.Prices || item?.prices || [];
}

function getItemRewards(item) {
  return item?.Rewards || item?.rewards || item?.SpinRewards || item?.GashaDrops || [];
}

function getRewardField(reward, ...keys) {
  for (const key of keys) {
    if (reward && reward[key] !== undefined) return reward[key];
  }
  return undefined;
}

function normalizeStoreReward(reward) {
  if (!reward) return null;
  const typeRaw = getRewardField(reward, "Type", "type");
  const type = String(typeRaw || "").toUpperCase();
  const amount = parseInt(getRewardField(reward, "Amount", "amount", "min", "max") || 1, 10) || 1;
  const chance = Number(getRewardField(reward, "Weight", "weight", "chance") || 1);
  const currencyType = normalizeCurrencyName(getRewardField(reward, "CurrencyType", "currencyType", "typeInfo"));
  const cosmeticId = getRewardField(reward, "CosmeticId", "cosmeticId", "typeInfo");
  const cosmeticType = getRewardField(reward, "CosmeticType", "cosmeticType", "type");
  const rarity = getRewardField(reward, "Rarity", "rarity", "dropGroup");
  return {
    rawType: type,
    chance: chance > 0 ? chance : 1,
    amount,
    currencyType,
    cosmeticId,
    cosmeticType,
    rarity,
    original: reward
  };
}

function resolveCosmeticDefinition(rawType, cosmeticId) {
  const type = String(rawType || '').toUpperCase();
  const id = cosmeticId || null;
  if (!id) return null;
  if (type === 'SKIN' || type === 'COSMETIC') {
    return (SharedData.Skins_v4 || []).find(x => x && x.SkinID === id) || null;
  }
  if (type === 'EMOTE') {
    return (SharedData.Emotes_v2 || []).find(x => x && (x.EmoteID === id || x.Id === id)) || null;
  }
  if (type === 'ANIMATION') {
    return (SharedData.Animations_v2 || []).find(x => x && (x.AnimationID === id || x.Id === id)) || null;
  }
  if (type === 'FOOTSTEPS') {
    return (SharedData.Footsteps_v2 || []).find(x => x && (x.FootstepsID === id || x.Id === id)) || null;
  }
  return null;
}


function pickFromArray(list) {
  const pool = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

function getSkinPoolByRarity(rarity) {
  const target = String(rarity || 'COMMON').toUpperCase();
  return (SharedData.Skins_v4 || []).filter(skin => {
    if (!skin || !skin.SkinID) return false;
    if (skin.Hidden || skin.IsFallback || skin.NoGacha) return false;
    return String(skin.Rarity || 'COMMON').toUpperCase() === target;
  });
}

function makeWheelVisualEntry(segmentId, skinId, fallbackRarity = null) {
  const cosmetic = resolveCosmeticDefinition('SKIN', skinId);
  return {
    index: 0,
    segmentId: segmentId || skinId,
    rewardType: 'SKIN',
    cosmeticId: skinId,
    cosmetic: cosmetic || null,
    currencyType: null,
    amount: 1,
    rarity: fallbackRarity || cosmetic?.Rarity || null,
    FriendlyName: cosmetic?.FriendlyName || skinId,
    ItemId: skinId,
    Id: skinId,
    SkinId: skinId,
    CosmeticId: skinId,
    legacy: toLegacyRewardPayload({ rawType: 'SKIN', cosmeticId: skinId, amount: 1, rarity: fallbackRarity || cosmetic?.Rarity || null }, skinId)
  };
}

function buildWheelDisplayRewards(config, item) {
  if (Array.isArray(config?.wheelVisualRewards) && config.wheelVisualRewards.length) {
    return config.wheelVisualRewards.map((entry, index) => ({ ...entry, index }));
  }

  const normalized = EconomyController.normalizeRewards(item);
  return normalized.map((reward, index) => {
    let cosmeticId = reward.cosmeticId || null;
    const rawType = String(reward.rawType || '').toUpperCase();
    if ((rawType === 'SKIN' || rawType === 'COSMETIC') && (!cosmeticId || String(cosmeticId).toLowerCase() === 'random')) {
      cosmeticId = pickRandomSkinId({ rarity: reward.rarity || null, allowBetter: true });
    }
    const cosmetic = resolveCosmeticDefinition(rawType, cosmeticId);
    return {
      index,
      segmentId: cosmeticId || reward.currencyType || rawType || `segment_${index}`,
      rewardType: rawType,
      cosmeticId,
      cosmetic,
      currencyType: reward.currencyType || null,
      amount: reward.amount || 1,
      rarity: reward.rarity || cosmetic?.Rarity || null,
      FriendlyName: cosmetic?.FriendlyName || cosmeticId || reward.currencyType || rawType,
      ItemId: cosmeticId || reward.currencyType || rawType || `segment_${index}`,
      Id: cosmeticId || reward.currencyType || rawType || `segment_${index}`,
      SkinId: cosmeticId || null,
      CosmeticId: cosmeticId || null,
      legacy: toLegacyRewardPayload(reward, cosmeticId)
    };
  });
}

function getLegacyCosmeticType(rawType) {
  const type = String(rawType || '').toUpperCase();
  if (type === 'SKIN' || type === 'COSMETIC') return 'Skin';
  if (type === 'EMOTE') return 'Emote';
  if (type === 'ANIMATION') return 'Animation';
  if (type === 'FOOTSTEPS') return 'Footsteps';
  if (type === 'ACTION_EMOTE') return 'ActionEmote';
  return type || 'Skin';
}

function toLegacyRewardPayload(reward, resolvedCosmeticId = null) {
  if (!reward) return null;
  const rawType = String(reward.rawType || reward.Type || reward.type || '').toUpperCase();
  const rarity = reward.rarity || reward.Rarity || reward.dropGroup || null;
  const amount = Number(reward.amount || reward.Amount || reward.min || reward.max || 1) || 1;

  if (rawType === 'CURRENCY') {
    const currencyType = normalizeCurrencyName(reward.currencyType || reward.CurrencyType || reward.typeInfo);
    return {
      Type: 'Currency',
      type: 'CURRENCY',
      CurrencyType: currencyType,
      currencyType,
      Amount: amount,
      amount,
      Rarity: rarity,
      rarity,
      FriendlyName: String(currencyType || '').toUpperCase()
    };
  }

  if (['SKIN', 'COSMETIC', 'EMOTE', 'ANIMATION', 'FOOTSTEPS', 'ACTION_EMOTE', 'SHARDS'].includes(rawType)) {
    const cosmeticId = resolvedCosmeticId || reward.cosmeticId || reward.CosmeticId || reward.typeInfo || null;
    const cosmeticType = getLegacyCosmeticType(rawType);
    const cosmetic = resolveCosmeticDefinition(rawType, cosmeticId);
    return {
      Type: 'Cosmetic',
      type: 'COSMETIC',
      CosmeticType: cosmeticType,
      cosmeticType: cosmeticType.toUpperCase(),
      CosmeticId: cosmeticId,
      cosmeticId,
      Amount: amount,
      amount,
      Rarity: rarity || cosmetic?.Rarity || null,
      rarity: rarity || cosmetic?.Rarity || null,
      RawRewardType: rawType,
      FriendlyName: cosmetic?.FriendlyName || cosmeticId,
      Cosmetic: cosmetic || null,
      Skin: cosmetic || null,
      Item: cosmetic || null
    };
  }

  return {
    Type: rawType || 'Unknown',
    type: rawType || 'UNKNOWN',
    Amount: amount,
    amount,
    Rarity: rarity,
    rarity
  };
}

function findPurchasableItemByName(name) {
  const needle = String(name || "").trim().toLowerCase();
  if (!needle) return null;
  return (SharedData.PurchasableItems || []).find(i => String(i.Name || i.name || "").trim().toLowerCase() === needle);
}

function findPurchasableItemByIncludes(fragment) {
  const needle = String(fragment || "").trim().toLowerCase();
  if (!needle) return null;
  return (SharedData.PurchasableItems || []).find(i => String(i.Name || i.name || "").trim().toLowerCase().includes(needle));
}

const SHOP_ITEM_ALIASES = {
  common: 'shop_random_skin',
  common_skin: 'shop_random_skin',
  commonskin: 'shop_random_skin',
  random_skin: 'shop_random_skin',
  shop_random_skin: 'shop_random_skin',
  rare: '9_19_Special_Chase_Wheel',
  rare_skin: '9_19_Special_Chase_Wheel',
  rareskin: '9_19_Special_Chase_Wheel',
  epic: '7_30_Epic_Wheel',
  epic_skin: '7_30_Epic_Wheel',
  epicskin: '7_30_Epic_Wheel',
  lucky: 'lucky_spin_wheel',
  lucky_spin: 'lucky_spin_wheel',
  lucky_spin_wheel: 'lucky_spin_wheel',
  spin: 'lucky_spin_wheel',
  wheel: 'lucky_spin_wheel',
  gacha_showboat_wheel_v3: 'gacha_showboat_wheel_v3'
};

function resolvePurchasableItemWithAliases(rawName) {
  const original = String(rawName || '').trim();
  const lower = original.toLowerCase();
  if (!original) return null;

  const direct = findPurchasableItemByName(original);
  if (direct) return direct;

  if (SHOP_ITEM_ALIASES[lower]) {
    const aliased = findPurchasableItemByName(SHOP_ITEM_ALIASES[lower]);
    if (aliased) return aliased;
  }

  if (lower.includes('common')) {
    return findPurchasableItemByName('shop_random_skin')
      || findPurchasableItemByName('gacha_showboat_wheel_v3')
      || findPurchasableItemByIncludes('common');
  }

  if (lower.includes('rare')) {
    return findPurchasableItemByName('9_19_Special_Chase_Wheel')
      || findPurchasableItemByIncludes('rare');
  }

  if (lower.includes('epic')) {
    return findPurchasableItemByName('7_30_Epic_Wheel')
      || findPurchasableItemByIncludes('epic_wheel')
      || findPurchasableItemByIncludes('epic');
  }

  if (lower.includes('lucky') || lower.includes('spin') || lower.includes('wheel')) {
    return findPurchasableItemByName('gacha_showboat_wheel_v3')
      || findPurchasableItemByName('shop_random_skin');
  }

  return null;
}

function pickRandomSkinId({ rarity = null, allowBetter = true } = {}) {
  const rarityOrder = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'SPECIAL'];
  const minimumIndex = rarity ? Math.max(0, rarityOrder.indexOf(String(rarity).toUpperCase())) : 0;
  const skins = (SharedData.Skins_v4 || []).filter(skin => {
    if (!skin || !skin.SkinID) return false;
    if (skin.Hidden) return false;
    if (skin.IsFallback) return false;
    if (skin.NoGacha) return false;
    const skinRarity = String(skin.Rarity || 'COMMON').toUpperCase();
    const skinIndex = rarityOrder.indexOf(skinRarity);
    if (skinIndex === -1) return false;
    return allowBetter ? skinIndex >= minimumIndex : skinIndex === minimumIndex;
  });
  const pool = skins.length ? skins : (SharedData.Skins_v4 || []).filter(s => s && s.SkinID && !s.Hidden && !s.IsFallback);
  if (!pool.length) return 'SKIN16';
  return pool[Math.floor(Math.random() * pool.length)].SkinID;
}


function buildRaritySegments(segmentRarityCounts) {
  const segments = [];
  for (const [rarity, count] of Object.entries(segmentRarityCounts || {})) {
    const pool = getSkinPoolByRarity(rarity);
    for (let i = 0; i < Number(count || 0); i++) {
      const picked = pickFromArray(pool);
      // pool tem objetos de skin: usa só o SkinID (antes o objeto inteiro virava o "id" da recompensa)
      const chosen = (picked && picked.SkinID) || pickRandomSkinId({ rarity, allowBetter: false });
      segments.push({ rarity: String(rarity).toUpperCase(), skinId: chosen });
    }
  }
  return segments;
}

function createWheelShopConfig(config, segments, templateConfig = null) {
  const template = deepClone(templateConfig || SharedData.ShopDef?.LuckySpinWheels?.[0] || SharedData.ShopDef?.LuckySpinWheel || {});
  const dropChancesVisuals = {};
  const spinVisualDropsList = [];

  segments.forEach((segment, index) => {
    const skinId = segment.skinId || pickRandomSkinId({ rarity: segment.rarity || null, allowBetter: false });
    const cosmetic = resolveCosmeticDefinition('SKIN', skinId);
    const key = `${skinId}_${index}`;
    spinVisualDropsList.push(key);
    dropChancesVisuals[key] = {
      BackgroundImage: 'spr_wheel_bg_skins',
      DropGroups: [segment.rarity || cosmetic?.Rarity || 'COMMON'],
      FriendlyName: cosmetic?.FriendlyName || skinId,
      ItemSprite: 'skin_icon_random',
      Rarity: segment.rarity || cosmetic?.Rarity || 'COMMON',
      RewardType: 'SKIN',
      RewardTypeInfo: skinId,
      TextColor: '#FFFCD7'
    };
  });

  template.Id = config.sharedWheelId || template.Id || `${config.id}_wheel`;
  template.LuckySpinWheelPurchasableItem = config.sharedWheelId || template.LuckySpinWheelPurchasableItem || `${config.id}_wheel`;
  template.ShopItemHeader = config.shopHeader || template.ShopItemHeader || config.displayName;
  template.PopupHeader = config.shopHeader || template.PopupHeader || config.displayName;
  template.PopupSubHeader = config.subHeader || template.PopupSubHeader || config.subHeader;
  template.SpinHeader = config.spinHeader || template.SpinHeader || config.displayName;
  template.RotationItemList = segments.map(x => x.skinId);
  template.SpinVisualDropsList = spinVisualDropsList;
  template.DropChancesVisuals = dropChancesVisuals;
  template.Category = 'OFFERS';
  template.OpenPopupFromMainLobby = true;
  return template;
}

function buildSyntheticLuckyWheelItem(config) {
  if (Array.isArray(config?.syntheticRewards) && config.syntheticRewards.length) {
    return {
      Name: config?.itemName || `${config?.id || 'wheel'}_wheel`,
      prices: [{ amount: Number(config?.fallbackPrice?.amount || 0), currency: config?.fallbackPrice?.currency || 'gems' }],
      rewards: config.syntheticRewards.map(reward => ({
        chance: reward.chance,
        min: 1,
        max: 1,
        type: 'SKIN',
        typeInfo: reward.skinId,
        dropGroup: reward.rarity
      }))
    };
  }

  const shopConfig = config?.shopConfig || (SharedData.ShopDef || {}).LuckySpinWheel || {};
  const visuals = shopConfig.DropChancesVisuals || {};
  const segmentIds = Array.isArray(shopConfig.SpinVisualDropsList) && shopConfig.SpinVisualDropsList.length
    ? shopConfig.SpinVisualDropsList
    : Object.keys(visuals);

  const rewards = segmentIds.map((segmentId) => {
    const visual = visuals[segmentId] || null;
    const rewardType = String(visual?.RewardType || '').toUpperCase();
    const rewardTypeInfo = visual?.RewardTypeInfo || null;
    const fallbackSkin = Array.isArray(shopConfig.RotationItemList) && shopConfig.RotationItemList.length
      ? shopConfig.RotationItemList[Math.floor(Math.random() * shopConfig.RotationItemList.length)]
      : null;

    if (rewardType === 'CURRENCY' && rewardTypeInfo) {
      return {
        chance: 1,
        min: rewardTypeInfo === 'gems' ? 10 : 5,
        max: rewardTypeInfo === 'gems' ? 150 : 25,
        type: 'CURRENCY',
        typeInfo: rewardTypeInfo,
        dropGroup: visual?.Rarity || 'COMMON'
      };
    }

    return {
      chance: 1,
      min: 1,
      max: 1,
      type: rewardType || 'SKIN',
      typeInfo: rewardTypeInfo || fallbackSkin || 'SKIN711',
      dropGroup: visual?.Rarity || 'LEGENDARY'
    };
  });

  return {
    Name: config?.itemName || 'lucky_spin_wheel',
    prices: [{ amount: Number(config?.fallbackPrice?.amount || 0), currency: config?.fallbackPrice?.currency || 'default_free_spins' }],
    rewards
  };
}

function createSyntheticWheelConfig({
  id,
  displayName,
  sharedWheelId,
  fallbackPrice,
  rarityWeights,
  segmentRarityCounts,
  subHeader
}) {
  const segments = buildRaritySegments(segmentRarityCounts);
  const syntheticRewards = segments.map(segment => {
    const countForRarity = Number(segmentRarityCounts[segment.rarity] || 1);
    const chanceTotal = Number(rarityWeights[segment.rarity] || 0);
    return {
      skinId: segment.skinId,
      rarity: segment.rarity,
      chance: countForRarity > 0 ? (chanceTotal / countForRarity) : 1
    };
  });

  const wheelVisualRewards = segments.map((segment, index) => makeWheelVisualEntry(`${segment.skinId}_${index}`, segment.skinId, segment.rarity));
  const shopConfig = createWheelShopConfig({
    id,
    displayName,
    sharedWheelId,
    subHeader,
    shopHeader: displayName,
    spinHeader: displayName
  }, segments, SharedData.ShopDef?.LuckySpinWheels?.[0] || SharedData.ShopDef?.LuckySpinWheel || null);

  return {
    id,
    displayName,
    itemName: sharedWheelId,
    sharedWheelId,
    fallbackPrice,
    syntheticRewards,
    wheelVisualRewards,
    shopConfig,
    subHeader
  };
}

function buildWheelConfigs() {
  const shopDef = SharedData.ShopDef || {};
  const templateLucky = deepClone(shopDef.LuckySpinWheels?.[0] || shopDef.LuckySpinWheel || {});
  const luckyWheelId = templateLucky.Id || 'Console_lucky_spin_wheel';
  const luckyWheelItemName = templateLucky.LuckySpinWheelPurchasableItem || luckyWheelId;

  const common = createSyntheticWheelConfig({
    id: 'common',
    displayName: 'Common Wheel',
    sharedWheelId: 'Console_lucky_spin_wheel',
    fallbackPrice: { amount: 55, currency: 'gems' },
    rarityWeights: { COMMON: 35, UNCOMMON: 30, RARE: 25, EPIC: 9, LEGENDARY: 1 },
    segmentRarityCounts: { COMMON: 11, UNCOMMON: 10, RARE: 8, EPIC: 2, LEGENDARY: 1 },
    subHeader: 'Common or Better!'
  });

  const rare = createSyntheticWheelConfig({
    id: 'rare',
    displayName: 'Rare Wheel',
    sharedWheelId: 'Console_lucky_spin_wheel',
    fallbackPrice: { amount: 90, currency: 'gems' },
    rarityWeights: { RARE: 66, EPIC: 31, LEGENDARY: 3 },
    segmentRarityCounts: { RARE: 21, EPIC: 10, LEGENDARY: 1 },
    subHeader: 'Rare or Better!'
  });

  const epic = createSyntheticWheelConfig({
    id: 'epic',
    displayName: 'Epic Wheel',
    sharedWheelId: 'Console_lucky_spin_wheel',
    fallbackPrice: { amount: 199, currency: 'gems' },
    rarityWeights: { EPIC: 80, LEGENDARY: 20 },
    segmentRarityCounts: { EPIC: 25, LEGENDARY: 7 },
    subHeader: 'Epic or Better!'
  });

  const luckyShopConfig = createWheelShopConfig({
    id: 'lucky',
    displayName: 'Lucky Spin Wheel',
    sharedWheelId: luckyWheelId,
    subHeader: 'Legendary or Better!',
    spinHeader: templateLucky.SpinHeader || 'LUCKY_WHEEL_NAME',
    shopHeader: templateLucky.ShopItemHeader || 'Lucky Spin Wheel'
  }, (templateLucky.RotationItemList || []).slice(0, 32).map((skinId) => ({
    skinId,
    rarity: resolveCosmeticDefinition('SKIN', skinId)?.Rarity || 'LEGENDARY'
  })), templateLucky);

  const lucky = {
    id: 'lucky',
    displayName: 'Lucky Spin Wheel',
    itemName: luckyWheelItemName,
    sharedWheelId: luckyWheelId,
    fallbackPrice: { amount: 0, currency: 'default_free_spins' },
    isLuckySpin: true,
    shopConfig: luckyShopConfig,
    wheelVisualRewards: (luckyShopConfig.RotationItemList || []).slice(0, 32).map((skinId, index) => makeWheelVisualEntry(`${skinId}_${index}`, skinId))
  };

  return { common, rare, epic, lucky };
}

const WHEEL_CONFIGS = buildWheelConfigs();

const BackendUtils = {
  generateId: () => crypto.randomBytes(16).toString('hex'),
  createHash: (...args) => crypto.createHash('sha256').update(args.join('')).digest('hex'),
  getTimestamp: () => Math.floor(Date.now() / 1000),
  validateAuthHeader: (authHeader) => {
    if (!authHeader || typeof authHeader !== 'string') return null;
    try {
      const parsed = JSON.parse(authHeader);
      if (!parsed.DeviceId) return null;
      return { DeviceId: parsed.DeviceId, StumbleId: parsed.StumbleId };
    } catch {
      return null;
    }
  },
  createLoginHash: (deviceId, version, timestamp, stumbleId, steamTicket, scopelyId) => {
    const hashInput = `${deviceId}${version}${timestamp}${stumbleId || ''}${steamTicket || ''}${scopelyId || ''}${process.env.LeagueSalt}`;
    return crypto.createHash('md5').update(hashInput).digest('hex');
  },
  createRegularHash: (deviceId, googleId, token, timestamp, stumbleId, url, body) => {
    const hashInput = `${deviceId}${googleId}${token}${timestamp}${stumbleId}${url}${body || ''}${process.env.LeagueSalt}`;
    return crypto.createHash('md5').update(hashInput).digest('hex');
  },
  createGameId: (type = 'regular') => {
    const prefix = type === 'event' ? 'EV' : 'RG';
    return `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  },
  formatNumber: (num) => {
    return new Intl.NumberFormat('en-US').format(num);
  },
  GenAndroidId: () => {
    return `android-${crypto.randomBytes(8).toString('hex')}`;
  },
  GenCaracters: (length) => {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  },
  LeagueEncrypt: (text) => {
    const cipher = crypto.createCipheriv('aes-256-cbc', process.env.LeagueSalt, crypto.randomBytes(16));
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  },
  Hash: (algorithm, data) => {
    return crypto.createHash(algorithm).update(data).digest('hex');
  }
};

class Database {
  constructor() {
    this.mongoUri = process.env.mongoUri;
    this.dbName = 'LzLeague';
    this.client = null;
    this.db = null;
    this.collections = {
  Users: null,
  Analytics: null,
  News: null,
  Events: null,
  BattlePasses: null,
  Skins: null,
  Missions: null,
  PurchasableItems: null,
  Animations: null,
  Emotes: null,
  Footsteps: null
};
  }

  async connectWithRetry(maxRetries = 5, retryDelay = 5000) {
    let lastError;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        Console.log("Database", `Trying to connect (attempt ${attempt}/${maxRetries})...`);
        
        this.client = new MongoClient(this.mongoUri, {
          serverSelectionTimeoutMS: 30000,
          connectTimeoutMS: 30000,
          socketTimeoutMS: 45000,
        });
        
        await this.client.connect();
        this.db = this.client.db(this.dbName);
        this.collections.Users = this.db.collection("Users");
        this.collections.Analytics = this.db.collection("Analytics");
        this.collections.News = this.db.collection("News");
        this.collections.Events = this.db.collection("Events");
        this.collections.BattlePasses = this.db.collection("BattlePasses");
        this.collections.Skins = this.db.collection("Skins");
        this.collections.Missions = this.db.collection("Missions");
        this.collections.PurchasableItems = this.db.collection("PurchasableItems");
        this.collections.Animations = this.db.collection("Animations");
        this.collections.Emotes = this.db.collection("Emotes");
        this.collections.Footsteps = this.db.collection("Footsteps");

        await this.createIndexes();
        await this.autoPopulateSharedData();
        Console.log("Database", "Successfully connected to the database!");
        return true;
        
      } catch (error) {
        lastError = error;
        Console.error("Database", `Error in attempt ${attempt}:`, error.message);
        
        if (attempt < maxRetries) {
          Console.log("Database", `Waiting ${retryDelay/1000} seconds to try again...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }
    
    throw lastError;
  }

  async connect() {
    return this.connectWithRetry(5, 5000);
  }

async autoPopulateSharedData() {
    try {
        const sync = async (collection, items) => {
            if (!Array.isArray(items) || items.length === 0) return;
            await collection.deleteMany({});
            await collection.insertMany(items.map(x => ({ ...x })), { ordered: false });
        };
        await sync(this.collections.Skins, SharedData.Skins_v4);
        await sync(this.collections.Animations, SharedData.Animations_v2);
        await sync(this.collections.Emotes, SharedData.Emotes_v2);
        await sync(this.collections.Footsteps, SharedData.Footsteps_v2);
    } catch (error) {
        Console.error('Population', 'Error when popular collections:', error);
    }
  }
  async createIndexes() {
    await this.collections.Users.createIndexes([
      { key: { deviceId: 1 }, unique: true, sparse: true },
      { key: { stumbleId: 1 }, unique: true, sparse: true },
      { key: { username: 1 }, unique: true, sparse: true },
      { key: { friends: 1 } },
      { key: { sentFriendRequests: 1 } },
      { key: { receivedFriendRequests: 1 } },
      { key: { 'balances.name': 1 } }
    ]);

    await this.collections.Events.createIndex({ StartDateTime: 1, EndDateTime: 1 });
    await this.collections.BattlePasses.createIndex({ PassID: 1 });
    await this.collections.Skins.createIndex({ SkinID: 1 });
  }

  async getUserByQuery(query) {
    return await this.collections.Users.findOne(query);
  }

  async updateUser(query, updates) {
    await this.collections.Users.updateOne(query, { $set: updates });
    return await this.getUserByQuery(query);
  }

  async addToUserArray(query, arrayField, value) {
    return await this.collections.Users.updateOne(query, { $addToSet: { [arrayField]: value } });
  }

  async incrementUserBalance(query, currency, amount) {
    const result = await this.collections.Users.updateOne(
      { ...query, 'balances.name': currency },
      { $inc: { 'balances.$.amount': amount } }
    );

    if (result.matchedCount === 0 && amount > 0) {
      await this.collections.Users.updateOne(
        query,
        { $push: { balances: { name: currency, amount } } }
      );
    }
    return result;
  }

  async createUser(userData) {
    const result = await this.collections.Users.insertOne(userData);
    return { ...userData, _id: result.insertedId };
  }

  async getActiveEvents() {
    const now = new Date();
    return await this.collections.Events.find({
      StartDateTime: { $lte: now },
      EndDateTime: { $gte: now }
    }).toArray();
  }

  async getBattlePass(passId) {
    return await this.collections.BattlePasses.findOne({ PassID: passId });
  }

  async getSkinInfo(skinId) {
    return await this.collections.Skins.findOne({ SkinID: skinId });
  }

  async getMissionInfo(missionId) {
    return await this.collections.Missions.findOne({ Id: missionId });
  }

  async getPurchasableItem(itemId) {
    return await this.collections.PurchasableItems.findOne({ Name: itemId });
  }
}

const database = new Database();
database.connectWithRetry(5, 5000).catch(err => {
  console.error('Database connection error after all retries:', err);
  Console.error("Database", "Verify that the MongoDB Atlas cluster is online and that the IP address is open.");
  Console.error("Database", "Visit: https://cloud.mongodb.com -> Network Access -> Add IP Address -> 0.0.0.0/0");
  process.exit(1);
});

class UserModel {

  static async create(deviceId, platformData = {}) {
    const now = new Date();
    const userId = Math.floor(Math.random() * 999999);
    const username = `gg/lzleague<sup><#20d9ff>${userId}`;

    const user = {
      id: userId,
      deviceId,
      stumbleId: BackendUtils.generateId().toUpperCase(),
      username,
      country: 'PT',
      region: 'EU',
      token: CryptoUtils.SessionToken(),
      version: platformData.Version || '0.99',
      createdAt: now,
      lastLogin: now,
      newsVersion: 0,
      skillRating: 0,
      experience: 0,
      crowns: 0,
      hiddenRating: 0,
      isBanned: false,
      inventory: [{
        userId,
        itemId: 803,
        itemType: "DUPLICATE_BANK",
        item: "CONFIG_VERSION",
        amount: 3
      }],
      skins: ["SKIN1", "SKIN2"],
      emotes: ["emote_cry", "emote_hi", "emote_gg", "emote_haha", "emote_happy"],
      animations: ["animation1"],
      footsteps: ["footsteps_smoke"],
      friends: [],
      sentFriendRequests: [],
      receivedFriendRequests: [],
      tournamentSeasons: [
        {
          seasonId: 1,
          xp: 0,
          claimedAwards: []
        }
      ],
      hasBattlePass: false,
      passTokens: 0,
      freePassRewards: [],
      premiumPassRewards: [],
      balances: [
        { name: "coins", amount: 10000, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "remove_ads", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 2, lastGiven: now },
        { name: "video", amount: 50, secondsSince: 0, secondsPerUnit: 0, maxAmount: 5000, lastGiven: now },
        { name: "gems", amount: 52500, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "video_gems", amount: 10, secondsSince: 0, secondsPerUnit: 5400, maxAmount: 10, lastGiven: now },
        { name: "video_coins", amount: 8, secondsSince: 0, secondsPerUnit: 10800, maxAmount: 8, lastGiven: now },
        { name: "special_video", amount: 3, secondsSince: 0, secondsPerUnit: 28800, maxAmount: 3, lastGiven: now },
        { name: "skin_charge", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 5, lastGiven: now },
        { name: "skin_purchase", amount: 7, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 7, lastGiven: now },
        { name: "gem_charge", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 3, lastGiven: now },
        { name: "gem_purchase", amount: 1, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 1, lastGiven: now },
        { name: "dust", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "default_free_spins", amount: 1, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: new Date(Date.now() - 86400000) },
        { name: "default_free_ad_spins", amount: 16, secondsSince: 0, secondsPerUnit: 0, maxAmount: 16, lastGiven: new Date(Date.now() - 86400000) },
        { name: "remove_interstitial_ads", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 2, lastGiven: now },
        { name: "end_of_match", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: now },
        { name: "end_of_match_event", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: now },
        { name: "tournament_ticket_rare", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "tournament_ticket_legendary", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "video_coins_02", amount: 5, secondsSince: 0, secondsPerUnit: 28800, maxAmount: 5, lastGiven: now },
        { name: "aes", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "aec", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "ranked_friend_boost", amount: 3, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 3, lastGiven: now },
        { name: "stumble_coins", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "dust_backup", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now }
      ],
      Rewards: [],
      availableNewsVersion: 0,
      latestNewsIdBackend: 11698,
      battlePass: {
        freePassRewards: [],
        premiumPassRewards: [],
        passTokens: 0,
        hasPurchased: false,
        passID: 72,
        secondsToEnd: 904064,
        experience: 0,
        slotsClaimed: [],
        hasUsedDiscount: false,
        xpBooster: 0,
        coins: 0,
        hasUsedBonusDiscount: false,
        passDateId: 0
      },
      secondsSinceCreated: 0,
      age: (SharedData.TourX && SharedData.TourX.Count) || 0,
      kidFriendlyMode: 0,
      termsOfServiceVersion: 0,
      xpRoad: {
        userId,
        xpRoadId: 0,
        lastClaimedLevel: 1,
        isVeteran: true,
        claimedRewardsIds: [],
        hasBeenEnabled: true,
        currentLevelCap: 70,
        isOnboarding: false,
        onboardingFeaturesUnlocked: []
      },
      userFlags: {
        hasUsedFreeNameChange: false,
        hasCoinConversionPopupShown: false,
        hasCoinConversionCompleted: false
      },
      offerSequenceState: [],
      userProfile: {
        userId,
        userName: username,
        country: 'PL',
        trophies: 0,
        crowns: 0,
        experience: 0,
        hiddenRating: 0,
        isOnline: true,
        lastSeenDate: now.toISOString(),
        skin: "SKIN1",
        nativePlatformName: "android",
        ranked: {
          currentSeasonId: "LIVE_RANKED_SEASON_0",
          currentRankId: 1,
          currentTierIndex: 0
        },
        flags: 0
      },
      featureFlags: [
        "ActionEmotes",
        "ActionEmotesCustomPartyVisibility",
        "AssignInitialPhotonRegionBasedOnPing",
        "AvailableCosmetics",
        "BattlePassActivationButton",
        "BattlePassOffer",
        "BattlePassPremiumPopupImprovement",
        "BattlePassSkipButtonOnSections",
        "BattlePassTheme",
        "BattlePassV2",
        "Consensus",
        "UsePhotonTicketsEvents",
        "UsePhotonTicketsTournamentsX",
        "UserConfiguration",
        "UserGeneratedContent",
        "UserTimeRecords",
        "TournamentsX",
        "TournamentsXMeta",
        "ConsoleFreeSpin",
        "SimulationGamePayload",
        "SpecialEmoteFilter",
        "CreatorCodes",
        "CreatorsQR",
        "CustomizeEmotesOnCustomPartyLobby",
        "CustomParty",
        "DeltaSharedConfig",
        "DiscoverabilityEvents",
        "DynamicContainer",
        "EndOfMatchRewardedVideo",
        "FriendsList",
        "GraphicsQualitySettings",
        "Leaderboards",
        "LootBoxes",
        "MainMenuRevamp",
        "MatchmakingFilter",
        "MemoryFixesSections",
        "MergeParties",
        "Missions",
        "NewMatchmaking",
        "Offerwall",
        "OldPurchaserImplementation",
        "OneStopShop",
        "OneStopShop3dAnimations",
        "OneStopShop3dSkins",
        "OneStopShop3dTaunts",
        "PluginFactory",
        "ProjectVerano",
        "Pusher",
        "QuantumSystemManagement",
        "Ranked",
        "RankedPlayWithFriends",
        "RemoteLocalizations",
        "RoomManagement",
        "RoomManagementConsole",
        "SavePhotonRegionOnBackend",
        "ScopelyAccount",
        "ScopelyAccountApple",
        "SequentialOffers",
        "Shards",
        "ShardsDuplicateBank",
        "ShopOfferCentering",
        "ShopOfferPurchaseLimitIndicator",
        "SimulationGamePayload",
        "SpecialEmoteFilter",
        "StartupNewFlow",
        "StaticBundles",
        "SteamInventory",
        "TransferAppleIdAuthorization",
        "UsePhotonTicketsEvents",
        "UsePhotonTicketsTournamentsX",
        "UserConfiguration",
        "UserGeneratedContent",
        "UserTimeRecords",
        "WebGLRealMoneyOffers",
        "WorkshopCustomThumbnails",
        "XpRoad"
      ],
      googleId: platformData.googleId || '',
      facebookId: platformData.facebookId || '',
      appleId: platformData.appleId || '',
      scopelyId: platformData.scopelyId || '',
      steamTicket: platformData.steamTicket || '',
      equippedCosmetics: {
        skin: 'SKIN1',
        color: 'COLOR1',
        animation: 'animation1',
        footsteps: 'footsteps_smoke',
        emote1: 'emote_cry',
        emote2: 'emote_hi',
        emote3: 'emote_gg',
        emote4: 'emote_haha',
        actionEmote1: 1,
        actionEmote2: 2,
        actionEmote3: 3,
        actionEmote4: 4
      }
    };
    return await database.createUser(user);
  }


  static async findByDeviceId(deviceId) {
    return await database.getUserByQuery({ deviceId });
  }

  static async findByStumbleId(stumbleId) {
    return await database.getUserByQuery({ stumbleId });
  }

  static async findById(id) {
    return await database.getUserByQuery({ id: parseInt(id) });
  }

  static async update(stumbleId, updates) {
    return await database.updateUser({ stumbleId }, updates);
  }

  static async addBalance(deviceId, currency, amount) {
    return await database.incrementUserBalance({ deviceId }, normalizeCurrencyName(currency), amount);
  }

  static async removeBalance(deviceId, currency, amount) {
    return await database.incrementUserBalance({ deviceId }, normalizeCurrencyName(currency), -amount);
  }

  static async addSkin(stumbleId, skinId) {
    return await database.addToUserArray({ stumbleId }, 'skins', skinId);
  }

  static async addActionEmote(stumbleId, emoteId) {
    return await database.addToUserArray({ stumbleId }, 'actionEmotes', emoteId);
  }

  static async setEquippedCosmetic(stumbleId, cosmeticType, cosmeticId) {
    const user = await this.findByStumbleId(stumbleId);
    if (!user) throw new Error("User not found");

    const updatedCosmetics = { ...user.equippedCosmetics, [cosmeticType]: cosmeticId };
    return await this.update(stumbleId, { equippedCosmetics: updatedCosmetics });
  }

  static async claimBattlePassSlot(deviceId, slotKey) {
    const user = await this.findByDeviceId(deviceId);
    if (user.battlePass.slotsClaimed.includes(slotKey)) {
      throw new Error("Slot already claimed");
    }

    await database.collections.Users.updateOne(
      { deviceId },
      { $push: { 'battlePass.slotsClaimed': slotKey } }
    );
    return await this.findByDeviceId(deviceId);
  }

  static async addBattlePassExperience(deviceId, xpToAdd) {
    const user = await this.findByDeviceId(deviceId);
    const newXP = (user.battlePass.experience || 0) + xpToAdd;

    await database.collections.Users.updateOne(
      { deviceId },
      { $set: { 'battlePass.experience': newXP } }
    );

    return await this.findByDeviceId(deviceId);
  }

  static async GetHighscore(type, country, start = 0, count = 50) {
    const filter = {};
    const projection = { username: 1, country: 1, _id: 0 };
    let sortField;
    let valueField;

    if (type === "crowns") {
      filter.crowns = { $gt: 0 };
      projection.crowns = 1;
      sortField = "crowns";
      valueField = "Crowns";
    } else if (type === "rank") {
      filter.skillRating = { $gt: 0 };
      projection.skillRating = 1;
      sortField = "skillRating";
      valueField = "SkillRating";
    }

    if (country && country.toLowerCase() !== "") {
      filter.country = country;
    }

    const users = await database.collections.Users
      .find(filter)
      .sort({ [sortField]: -1 })
      .project(projection)
      .skip(parseInt(start))
      .limit(parseInt(count))
      .toArray();

    if (users.length === 0) {
      return { Error: "No users found" };
    }

    const scores = users.map(user => {
      const value = type === "crowns" ? user.crowns : user.skillRating;
      return {
        User: {
          Username: user.username,
          Country: user.country || "Unknown",
          [valueField]: value
        }
      };
    });

    return { scores };
  }

  static getBalanceAmount(user, currency) {
    const normalizedCurrency = normalizeCurrencyName(currency);
    const balance = (user.balances || []).find(b => normalizeCurrencyName(b.name) === normalizedCurrency);
    return balance ? balance.amount : 0;
  }

  static getLevel(xp) {
    return Math.floor((xp + 1032700) / 30000) - 9;
  }
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    req.user = null;

    if (!authHeader) {
      return next();
    }

    let authData;
    try {
      authData = JSON.parse(authHeader);
    } catch (e) {
      return next();
    }

    const { DeviceId, StumbleId } = authData;

    const user = StumbleId
      ? await UserModel.findByStumbleId(StumbleId)
      : await UserModel.findByDeviceId(DeviceId);

    req.user = user;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

async function generatePhotonJwt(user) {
  const payload = {
    stumbleId: user.stumbleId,
    deviceId: user.deviceId,
    username: user.username
  };

  const secret = process.env.LeagueSalt;
  const options = { expiresIn: '30d', issuer: 'StumbleVenusPhoton' };

  return new Promise((resolve, reject) => {
    jwt.sign(payload, secret, options, (err, token) => {
      if (err) reject(err);
      else resolve(token);
    });
  });
}

async function VerifyPhoton(req, res) {
  try {
    // O Photon manda o JWT no header Authorization (ou no corpo, dependendo da versão)
    let token = req.headers.authorization || req.body?.token || req.body?.Token || req.query?.token;
    if (!token) {
      return res.json({ ResultCode: -1, Message: "Authorization header missing" });
    }
    token = String(token).replace(/^Bearer\s+/i, '').trim();

    let decoded;
    try {
      decoded = jwt.verify(token, process.env.LeagueSalt, { issuer: 'StumbleLandPhoton' });
    } catch (err) {
      return res.json({ ResultCode: -1, Message: "Invalid token" });
    }

    // O usuário vem do próprio token (antes vinha do 3º parâmetro do Express, que é o next())
    const user = await UserModel.findByStumbleId(decoded.stumbleId);
    if (!user) {
      return res.json({ ResultCode: -1, Message: "User not found" });
    }
    if (user.isBanned) {
      return res.json({ ResultCode: -1, Message: "User banned" });
    }
    if (decoded.deviceId !== user.deviceId) {
      return res.json({ ResultCode: -1, Message: "Token validation failed" });
    }

    return res.json({ ResultCode: 1, UserId: token });
  } catch (err) {
    Console.error("VerifyPhoton", "Error: " + (err && err.message));
    return res.status(500).json({ ResultCode: -1, Message: "Internal server error" });
  }
}

class UserController {
  static async login(req, res) {
    try {
      const { DeviceId, StumbleId, SteamTicket, ScopelyId, Version, newUsername } = req.body;

      if (!DeviceId) {
        return res.status(400).json({ message: 'DeviceId is required' });
      }

      let user = null;
      if (StumbleId) {
        user = await UserModel.findByStumbleId(StumbleId);
      }

      if (!user) {
        user = await UserModel.findByDeviceId(DeviceId);
      }

      if (!user) {
        Console.log("Login", "Creating a new user with the deviceId: " + DeviceId);
        user = await UserModel.create(DeviceId, { steamTicket: SteamTicket, scopelyId: ScopelyId, Version });
      }

      // If a newUsername was sent, update the user's username.
      if (newUsername && newUsername !== user.username) {
        // Basic username validation
        if (!/^[a-zA-Z0-9_\s]+$/.test(newUsername)) {
          return res.status(422).json({ message: 'Username can only contain letters, numbers, underscores and spaces' });
        }

        if (newUsername.length < 4 || newUsername.length > 12) {
          return res.status(422).json({ message: 'Username must be between 4 and 12 characters' });
        }

        // Check if the username already exists.
        const existingUser = await database.getUserByQuery({ username: newUsername });
        if (existingUser && existingUser._id.toString() !== user._id.toString()) {
          return res.status(409).json({ message: 'Username already taken' });
        }

        // Update the username in the database.
        user = await UserModel.update(user.stumbleId, { username: newUsername });
        Console.log("Login", "Username updated to: " + newUsername + " for user: " + user.stumbleId);
      }

      const desiredTourX = (SharedData.TourX && SharedData.TourX.Count) || 0;
      if ((user.age || 0) !== desiredTourX) {
        user = await UserModel.update(user.stumbleId, { age: desiredTourX });
      }
      const photonJwt = await generatePhotonJwt(user);

     if (user.isBanned) {
  return res.status(403).send("BANNED");
}

      return res.status(200).json({
        User: user,
        PhotonJwt: photonJwt,
        equippedCosmetics: user.equippedCosmetics
      });
    } catch (err) {
      Console.error('Login', 'Error:', err);
      return res.status(500).json({ message: 'Internal server error during login' });
    }
  }

  static async getConfig(req, res) {
    try {
      const config = {
        _SharedVersion: 2,
        Versions: {
          AndroidLastVersionAvailable: 0.59
        },
        BattlePassRotation: SharedData.BattlePassRotation || [],
        BattlePassesV3: SharedData.BattlePasses || [],
        RoundLevels_v2: SharedData.RoundLevels_v2 || [],
        Skins_v4: SharedData.Skins_v4 || [],
        MissionObjectives: SharedData.MissionObjectives || [],
        PurchasableItems: SharedData.PurchasableItems || [],
        GameEvents: SharedData.GameEvents || [],
        Animations: SharedData.Animations || [],
        Animations_v2: SharedData.Animations_v2 || [],
        AdSettings: SharedData.AdSettings || {},
        AnalyticsSettings: SharedData.AnalyticsSettings || {},
        BackendUrl: SharedData.BackendUrl || "",
        BattlePass: SharedData.BattlePass || {},
        ActionEmotes: SharedData.ActionEmotes || {},
        RankedPlaySettings: SharedData.RankedPlaySettings || {}
      };

      res.json(config);
    } catch (err) {
      Console.error('Config', 'Error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  // Endpoint compatível com POST /user/changeusername.
  // Body aceito: { "NewUsername": "Nome" }.
  // UserId é opcional para compatibilidade, mas só permite alterar a própria conta autenticada.
  static async changeUsername(req, res) {
    try {
      const body = req.body || {};
      const newUsername = body.NewUsername;
      const requestedId = body.UserId == null ? null : String(body.UserId).trim();
      const user = req.user;

      if (!user || !user.stumbleId) {
        return res.status(401).json({ message: 'Unauthorized' });
      }

      if (requestedId) {
        const matchesOwnAccount =
          requestedId === String(user.stumbleId) ||
          requestedId === String(user.id) ||
          (/^\\d{1,12}$/.test(requestedId) && Number(requestedId) === Number(user.id));

        if (!matchesOwnAccount) {
          return res.status(403).json({ message: 'You can only change your own username' });
        }
      }

      if (typeof newUsername !== 'string') {
        return res.status(422).json({ message: 'Username must be a string' });
      }

      const finalUsername = newUsername.trim();
      if (finalUsername.length < 4 || finalUsername.length > 12) {
        return res.status(422).json({ message: 'Username must be between 4 and 12 characters' });
      }

      const existingUser = await database.getUserByQuery({ username: finalUsername });
      if (existingUser && String(existingUser.stumbleId) !== String(user.stumbleId)) {
        return res.status(409).json({ message: 'Username already taken' });
      }

      const oldNames = Array.isArray(user.oldNames) ? [...user.oldNames] : [];
      if (user.username && user.username !== finalUsername) {
        oldNames.push({ name: user.username, changedAt: new Date() });
      }

      const updatedUser = await UserModel.update(user.stumbleId, {
        username: finalUsername,
        'userProfile.userName': finalUsername,
        oldNames
      });

      Console.log('Username', `id ${user.id}: "${user.username}" -> "${finalUsername}"`);
      return res.status(200).json({ User: updatedUser });
    } catch (err) {
      if (err && err.code === 11000) {
        return res.status(409).json({ message: 'Username already taken' });
      }
      Console.error('Username', 'changeUsername error:', err);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

 static async updateUsername(req, res) {
  try {
    const { Username } = req.body;
    const { user } = req;

    if (!Username || Username.length < 3 || Username.length > 12) {
      return res.status(401).json({ message: 'esse é bem burro' });
    }

    if (/[{}<>()"'`~#$%^&*=+\\\/|:;,?!]/.test(Username)) {
      return res.status(403).json({ message: 'npode isso chupapica' });
    }

    const existingUser = await database.getUserByQuery({ username: Username });
    if (existingUser) {
      return res.status(409).json({ message: 'Username already taken' });
    }

    const tagItems = user.inventory
      ? user.inventory.filter(i => i.itemType === "TAG" && typeof i.item === "string")
      : [];

    const tagsToAdd = tagItems.map(t => {
      let tag = t.item.replace(/^tag_/, '');
      if (t.amount > 1) tag += `+${t.amount}`;
      return tag;
    });

    let finalUsername = Username;

    if (tagsToAdd.length > 0) {
      finalUsername += " " + tagsToAdd.join(" ");
    }

    const oldNames = Array.isArray(user.oldNames) ? user.oldNames : [];
    oldNames.push({
      name: user.username,
      changedAt: new Date()
    });

    const updates = {
      username: finalUsername,
      "userProfile.userName": finalUsername,
      oldNames: oldNames
    };

    const updatedUser = await UserModel.update(user.stumbleId, updates);
    await UserModel.removeBalance(user.deviceId, "gems", 100);

    console.log(`${user.username} changed username to ${finalUsername}`);

    res.status(200).json({ User: updatedUser });

  } catch (err) {
    console.error("error updating username:", err);
    res.status(500).json({ message: "internal server error" });
  }
}

  static async getSettings(req, res) {
    try {
        const settings = {
            friendIsOnlinePush: true,
            invitedToPartyPush: true,
            partyInviteToastNotification: true,
            partyInviteInGameToastNotification: true
        };

        res.json(settings);
    } catch (err) {
        Console.error('Settings', 'Error:', err);
        res.status(500).json({ message: 'Internal server error' });
    }
}

  static async getProfile(req, res) {
    try {
      const { userID } = req.body;
      let user = null;

      if (userID) {
        user = await UserModel.findById(userID);
      }

      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }

      res.json({
        User: user.userProfile
      });
    } catch (err) {
      Console.error('Profile', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async addSkin(req, res) {
    try {
      const { user } = req;
      const { skinId } = req.body;

      if (!skinId) {
        return res.status(400).json({ message: 'skinId is required' });
      }

      await UserModel.addSkin(user.stumbleId, skinId);
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Add skin error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async setEquippedCosmetic(req, res) {
    try {
      const { user } = req;
      const { cosmeticType, cosmeticId } = req.body;

      if (!cosmeticType || !cosmeticId) {
        return res.status(400).json({ message: 'Both cosmeticType and cosmeticId are required' });
      }

      const updatedUser = await UserModel.setEquippedCosmetic(user.stumbleId, cosmeticType, cosmeticId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Set equipped error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async updateCosmetics(req, res) {
    try {
      const { user } = req;
      const {
        skin, color, animation, footsteps,
        emote1, emote2, emote3, emote4,
        actionEmote1, actionEmote2, actionEmote3, actionEmote4
      } = req.body;

      const updates = {
        equippedCosmetics: {
          skin: skin || user.equippedCosmetics.skin,
          color: color || user.equippedCosmetics.color,
          animation: animation || user.equippedCosmetics.animation,
          footsteps: footsteps || user.equippedCosmetics.footsteps,
          emote1: emote1 || user.equippedCosmetics.emote1,
          emote2: emote2 || user.equippedCosmetics.emote2,
          emote3: emote3 || user.equippedCosmetics.emote3,
          emote4: emote4 || user.equippedCosmetics.emote4,
          actionEmote1: actionEmote1 || user.equippedCosmetics.actionEmote1,
          actionEmote2: actionEmote2 || user.equippedCosmetics.actionEmote2,
          actionEmote3: actionEmote3 || user.equippedCosmetics.actionEmote3,
          actionEmote4: actionEmote4 || user.equippedCosmetics.actionEmote4
        }
      };

      const updatedUser = await UserModel.update(user.stumbleId, updates);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Update error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async deleteAccount(req, res) {
    try {
      const { user } = req;
      const newUsername = `#${BackendUtils.GenCaracters(11)}`;

      await UserModel.update(user.deviceId, { username: newUsername });
      await database.collections.Users.deleteOne({ deviceId: user.deviceId });

      res.json({ message: 'Account deleted successfully' });
    } catch (err) {
      Console.error('Account', 'Delete error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async linkPlatform(req, res) {
    try {
      const { platform, platformId } = req.body;
      const { user } = req;

      const validPlatforms = ['google', 'apple', 'facebook', 'scopely'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ message: 'Invalid platform' });
      }

      const platformIdMD5 = BackendUtils.Hash('md5', platformId || `${platform}-${user.username}-${process.env.LeagueSalt}`);
      const updateField = `${platform}Id`;

      const updatedUser = await UserModel.update(user.deviceId, { [updateField]: platformIdMD5 });
      res.json({ User: updatedUser, message: `Successfully linked ${platform} account` });
    } catch (err) {
      Console.error('Platform', 'Link error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async unlinkPlatform(req, res) {
    try {
      const { platform } = req.body;
      const { user } = req;

      const validPlatforms = ['google', 'apple', 'facebook', 'scopely'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ message: 'Invalid platform' });
      }

      const updateField = `${platform}Id`;
      const updatedUser = await UserModel.update(user.deviceId, { [updateField]: '' });

      res.json({ User: updatedUser, message: `Successfully unlinked ${platform} account` });
    } catch (err) {
      Console.error('Platform', 'Unlink error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class RoundController {
  static async finishRound(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;

      if (!round) {
        return res.status(400).json({ message: 'Round is required' });
      }

      const rewards = {
        crowns: round === '3' ? 1 : round === '2' ? 0 : 0,
        skillRating: round === '3' ? 20 : round === '2' ? 10 : 0,
        experience: 100
      };

      const updatedUser = await UserModel.update(user.deviceId, {
        crowns: user.crowns + rewards.crowns,
        skillRating: user.skillRating + rewards.skillRating,
        experience: user.experience + rewards.experience
      });

      res.status(200).json({
        User: updatedUser,
        Rewards: rewards
      });
    } catch (err) {
      Console.error('Round', 'Finish error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async finishCustomRound(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;

      res.json({
        User: user,
        message: 'Custom round finished successfully'
      });
    } catch (err) {
      Console.error('Round', 'Custom finish error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async finishRoundV4(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;
      const { gameType, variantId } = req.body;

      const gameId = BackendUtils.createGameId(gameType === 'event' ? 'event' : 'regular');
      const levelIds = SharedData.RoundLevels_v2.map(level => level.LevelID).slice(0, 3);

      const roundPayloads = {};
      const placements = {};
      const eliminatedPlayers = [];
      const usersLastRound = {};

      if (round === '1') {
        placements[user.id] = 16;
        usersLastRound[user.id] = 1;
        roundPayloads[1] = {
          EliminatedPlayers: [user.id, ...Array(15).fill(0).map((_, i) => 1000 + i)],
          LevelId: levelIds[0],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
      } else if (round === '2') {
        placements[user.id] = 8;
        usersLastRound[user.id] = 2;
        roundPayloads[1] = {
          EliminatedPlayers: [],
          LevelId: levelIds[0],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
        roundPayloads[2] = {
          EliminatedPlayers: [user.id, ...Array(7).fill(0).map((_, i) => 1000 + i)],
          LevelId: levelIds[1],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
      } else if (round === '3') {
        placements[user.id] = 1;
        usersLastRound[user.id] = 3;
        roundPayloads[1] = {
          EliminatedPlayers: [],
          LevelId: levelIds[0],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
        roundPayloads[2] = {
          EliminatedPlayers: [],
          LevelId: levelIds[1],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
        roundPayloads[3] = {
          EliminatedPlayers: [],
          LevelId: levelIds[2],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
      }

      const clientViewPayload = {
        AverageMmr: null,
        CurrentRound: parseInt(round),
        ExpectedRounds: 3,
        FrameNumber: 7814,
        GameId: gameId,
        GameType: gameType === 'event' ? "Event" : "Regular",
        Placements: null,
        RoundPayloads: roundPayloads,
        StartingUsers: 32,
        UsersLastRound: usersLastRound,
        VariantId: variantId || null
      };

      const rewards = {
        crowns: round === '3' ? 1 : round === '2' ? 0 : 0,
        skillRating: round === '3' ? 20 : round === '2' ? 10 : 0,
        experience: 100
      };

      const updatedUser = await UserModel.update(user.deviceId, {
        crowns: user.crowns + rewards.crowns,
        skillRating: user.skillRating + rewards.skillRating,
        experience: user.experience + rewards.experience
      });

      res.status(200).json({
        ClientViewPayload: clientViewPayload,
        ClientViewPlacements: null,
        FriendsCount: 0,
        LevelIds: levelIds,
        MissionsProgression: {},
        SignedPayload: "",
        User: updatedUser,
        Rewards: rewards
      });
    } catch (err) {
      Console.error('Round', 'FinishV4 error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class BattlePassController {
  static async getBattlePass(req, res) {
    try {
      const now = new Date();
      const activePass = SharedData.BattlePassRotation.find(pass => {
        const startDate = new Date(pass.StartDate);
        const endDate = new Date(pass.EndDate);
        return startDate <= now && now <= endDate;
      });

      if (!activePass) {
        return res.status(404).json({ message: 'No active battle pass found' });
      }

      const battlePass = SharedData.BattlePasses.find(bp => bp.PassID === activePass.PassID);
      if (!battlePass) {
        return res.status(404).json({ message: 'Battle pass data not found' });
      }

      res.json([battlePass]);
    } catch (err) {
      Console.error('BattlePass', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimReward(req, res) {
    try {
      const { user } = req;
      const { Page, Section, Slot, IsPremium } = req.body;

      if (Page === undefined || Section === undefined || Slot === undefined) {
        return res.status(400).json({ message: 'Page, Section and Slot are required' });
      }

      const slotKey = `${Page},${Section},${Slot}`;
      if (user.battlePass.slotsClaimed.includes(slotKey)) {
        return res.status(400).json({ message: 'Slot already claimed' });
      }

      await database.collections.Users.updateOne(
        { deviceId: user.deviceId },
        { $push: { 'battlePass.slotsClaimed': slotKey } }
      );

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('BattlePass', 'Claim error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async purchaseBattlePass(req, res) {
    try {
      const { user } = req;

      if (user.battlePass.hasPurchased) {
        return res.status(400).json({ message: 'Battle pass already purchased' });
      }

      const gemsBalance = UserModel.getBalanceAmount(user, 'gems');
      if (gemsBalance < 1200) {
        return res.status(400).json({ message: 'Not enough gems' });
      }

      await UserModel.removeBalance(user.deviceId, 'gems', 1200);
      await UserModel.update(user.deviceId, { 'battlePass.hasPurchased': true });

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('BattlePass', 'Purchase error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async completeBattlePass(req, res) {
    try {
      const { user } = req;
      const battlePass = SharedData.BattlePasses[0];

      if (!battlePass) {
        return res.status(404).json({ message: 'No battle pass data available' });
      }

      const claimedSlots = user.battlePass.slotsClaimed || [];
      const userCoins = user.battlePass.coins || 0;
      const userExperience = user.battlePass.experience || 0;
      const xpToLevelUp = battlePass.XPToLevelUp || 1000;

      const calculateLevel = (experience) => {
        return Math.floor(experience / xpToLevelUp);
      };

      const playerLevel = calculateLevel(userExperience);

      for (const [pageIndex, page] of battlePass.Content.Pages.entries()) {
        for (const [sectionIndex, section] of page.Sections.entries()) {
          const sectionUnlockLevel = section.UnlockLevel || 0;
          if (playerLevel >= sectionUnlockLevel) {
            for (const [slotIndex, slot] of section.Slots.entries()) {
              const slotKey = `${pageIndex},${sectionIndex},${slotIndex}`;
              if (!claimedSlots.includes(slotKey)) {
                if (userCoins >= slot.UnlockCost && (!slot.IsPremium || user.battlePass.hasPurchased)) {
                  await database.collections.Users.updateOne(
                    { deviceId: user.deviceId },
                    { $push: { 'battlePass.slotsClaimed': slotKey } }
                  );
                }
              }
            }
          }
        }
      }

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('BattlePass', 'Complete error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class EconomyController {
  static getWheelConfig(wheelType) {
    const key = String(wheelType || 'lucky').toLowerCase();
    return WHEEL_CONFIGS[key] || WHEEL_CONFIGS.lucky;
  }

  static resolveWheelItem(wheelType) {
    const cfg = EconomyController.getWheelConfig(wheelType);
    // Roletas common/rare/epic têm recompensas e preço próprios: usam sempre o item sintético
    // (antes davam 404 SPIN_NOT_CONFIGURED e, se achassem o item da lucky, usariam as recompensas erradas)
    if (Array.isArray(cfg.syntheticRewards) && cfg.syntheticRewards.length) {
      return { config: cfg, item: buildSyntheticLuckyWheelItem(cfg) };
    }
    const primary = findPurchasableItemByName(cfg.itemName);
    if (primary) return { config: cfg, item: primary };
    if (cfg.consoleItemName) {
      const consoleItem = findPurchasableItemByName(cfg.consoleItemName);
      if (consoleItem) return { config: cfg, item: consoleItem };
    }
    if (cfg.isLuckySpin) {
      return { config: cfg, item: buildSyntheticLuckyWheelItem(cfg) };
    }
    return { config: cfg, item: null };
  }

  static getRequestItemId(req) {
    return req.params.itemId || req.params.item || req.query.itemId || req.query.item || req.query.name || req.query.id || req.query.type || null;
  }

  static resolveShopItem(req) {
    const rawItemId = EconomyController.getRequestItemId(req);
    const directItem = resolvePurchasableItemWithAliases(rawItemId);
    if (directItem) return { item: directItem, itemId: rawItemId || directItem.Name || directItem.name, source: 'direct' };

    const wheelType = req.params.wheelType || req.query.wheelType || req.query.type || rawItemId || 'lucky';
    const wheelResolved = EconomyController.resolveWheelItem(wheelType);
    if (wheelResolved.item) return { item: wheelResolved.item, itemId: rawItemId || wheelType, source: 'wheel', config: wheelResolved.config };

    return { item: null, itemId: rawItemId, source: 'none', config: null };
  }

  static getPriceForItem(item, fallbackPrice = null) {
    const prices = getItemPrices(item);
    if (prices.length > 0) {
      const raw = prices[0];
      return {
        amount: Number(raw.Amount ?? raw.amount ?? fallbackPrice?.amount ?? 0),
        currency: normalizeCurrencyName(raw.Currency ?? raw.currency ?? fallbackPrice?.currency ?? 'gems')
      };
    }
    return {
      amount: Number(fallbackPrice?.amount ?? 0),
      currency: normalizeCurrencyName(fallbackPrice?.currency ?? 'gems')
    };
  }

  static normalizeRewards(item) {
    return getItemRewards(item)
      .map(normalizeStoreReward)
      .filter(Boolean);
  }

  static chooseReward(rewards) {
    const totalWeight = rewards.reduce((sum, reward) => sum + (Number(reward.chance) || 0), 0);
    if (totalWeight <= 0) return null;
    const roll = Math.random() * totalWeight;
    let cumulative = 0;
    for (const reward of rewards) {
      cumulative += Number(reward.chance) || 0;
      if (roll <= cumulative) return reward;
    }
    return rewards[rewards.length - 1] || null;
  }

  static async applyReward(user, reward) {
    if (!reward) return null;

    if (reward.rawType === 'CURRENCY') {
      await UserModel.addBalance(user.deviceId, reward.currencyType, reward.amount);
      return {
        type: 'CURRENCY',
        currencyType: reward.currencyType,
        amount: reward.amount,
        rarity: reward.rarity,
        legacy: toLegacyRewardPayload(reward)
      };
    }

    if (['SKIN', 'COSMETIC', 'EMOTE', 'ANIMATION', 'FOOTSTEPS', 'SHARDS'].includes(reward.rawType)) {
      let cosmeticId = reward.cosmeticId;
      if ((reward.rawType === 'SKIN' || reward.rawType === 'COSMETIC') && (!cosmeticId || String(cosmeticId).toLowerCase() === 'random')) {
        const requestedRarity = String(reward.rarity || 'COMMON').toUpperCase();
        cosmeticId = pickRandomSkinId({ rarity: requestedRarity, allowBetter: true });
      }
      if (reward.rawType === 'SKIN' || reward.rawType === 'COSMETIC') {
        await UserModel.addSkin(user.stumbleId, cosmeticId);
      } else if (reward.rawType === 'EMOTE') {
        await database.addToUserArray({ stumbleId: user.stumbleId }, 'emotes', cosmeticId);
      } else if (reward.rawType === 'ANIMATION') {
        await database.addToUserArray({ stumbleId: user.stumbleId }, 'animations', cosmeticId);
      } else if (reward.rawType === 'FOOTSTEPS') {
        await database.addToUserArray({ stumbleId: user.stumbleId }, 'footsteps', cosmeticId);
      }
      const cosmetic = resolveCosmeticDefinition(reward.rawType, cosmeticId);
      return {
        type: reward.rawType,
        cosmeticType: reward.cosmeticType,
        cosmeticId,
        amount: reward.amount,
        rarity: reward.rarity || cosmetic?.Rarity || null,
        cosmetic,
        legacy: toLegacyRewardPayload(reward, cosmeticId)
      };
    }

    return {
      type: reward.rawType || 'UNKNOWN',
      amount: reward.amount,
      rarity: reward.rarity,
      raw: reward.original,
      legacy: toLegacyRewardPayload(reward)
    };
  }

  static async spendWheelPrice(user, price, isLuckySpin = false, preferredSpinType = null) {
    if (isLuckySpin) {
      const freeSpins = UserModel.getBalanceAmount(user, 'default_free_spins');
      const adSpins = UserModel.getBalanceAmount(user, 'default_free_ad_spins');
      // Se o cliente pediu giro por anúncio, gasta o giro de anúncio primeiro
      if (/ad/i.test(String(preferredSpinType || '')) && adSpins > 0) {
        await UserModel.removeBalance(user.deviceId, 'default_free_ad_spins', 1);
        return 'default_free_ad_spins';
      }
      if (freeSpins > 0) {
        await UserModel.removeBalance(user.deviceId, 'default_free_spins', 1);
        return 'default_free_spins';
      }
      if (adSpins > 0) {
        await UserModel.removeBalance(user.deviceId, 'default_free_ad_spins', 1);
        return 'default_free_ad_spins';
      }
      throw Object.assign(new Error('NO_SPINS_AVAILABLE'), { statusCode: 402 });
    }

    const currentBalance = UserModel.getBalanceAmount(user, price.currency);
    if (currentBalance < price.amount) {
      throw Object.assign(new Error('INSUFFICIENT_FUNDS'), { statusCode: 402 });
    }

    if (price.amount > 0) {
      await UserModel.removeBalance(user.deviceId, price.currency, price.amount);
    }
    return price.currency;
  }

  static formatWheelResponse({ config, item, price, spendCurrency, reward, updatedUser }) {
    const legacyReward = reward?.legacy || toLegacyRewardPayload(reward, reward?.cosmeticId);
    const cosmetic = reward?.cosmetic || resolveCosmeticDefinition(reward?.type, reward?.cosmeticId);
    const rewards = legacyReward ? [legacyReward] : [];
    const wheelItems = buildWheelDisplayRewards(config, item).slice(0, 64);
    return {
      success: true,
      wheelType: config.id,
      wheelName: config.displayName,
      itemName: item?.Name || item?.name || config.itemName,
      spent: {
        currency: spendCurrency,
        amount: config.isLuckySpin ? 1 : Number(price.amount || 0)
      },
      spinType: String(spendCurrency || '').includes('ad') ? 'AdSpins' : 'FreeSpins',
      reward: legacyReward,
      Reward: legacyReward,
      rewards,
      Rewards: rewards,
      cosmetic: cosmetic || null,
      Cosmetic: cosmetic || null,
      skin: cosmetic || null,
      Skin: cosmetic || null,
      item: cosmetic || null,
      Item: cosmetic || null,
      currentReward: legacyReward,
      CurrentReward: legacyReward,
      selectedItem: cosmetic || null,
      SelectedItem: cosmetic || null,
      unlockedItems: cosmetic ? [cosmetic] : [],
      Items: cosmetic ? [cosmetic] : [],
      wheelItems,
      WheelItems: wheelItems,
      luckySpinConfig: config.shopConfig || null,
      LuckySpinConfig: config.shopConfig || null,
      LuckySpinWheel: config.shopConfig || null,
      user: updatedUser,
      User: updatedUser
    };
  }

  static async purchase(req, res) {
    try {
      const { user } = req;
      const itemId = req.params.item;

      const item = findPurchasableItemByName(itemId);
      if (!item) return res.status(404).json({ error: 'ITEM_NOT_FOUND' });

      const price = EconomyController.getPriceForItem(item);
      const balance = UserModel.getBalanceAmount(user, price.currency);
      if (balance < price.amount) return res.status(402).json({ error: 'INSUFFICIENT_FUNDS' });

      if (price.amount > 0) {
        await UserModel.removeBalance(user.deviceId, price.currency, price.amount);
      }

      const rewards = [];
      for (const reward of EconomyController.normalizeRewards(item)) {
        const granted = await EconomyController.applyReward(user, reward);
        if (granted) rewards.push(granted);
      }

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({
        success: true,
        user: updatedUser,
        rewards
      });
    } catch (err) {
      Console.error('Economy', 'Purchase error:', err);
      res.status(err.statusCode || 500).json({ error: err.message || 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async purchaseGasha(req, res) {
    try {
      const { user } = req;
      const requestedCount = Math.max(1, Math.min(parseInt(req.params.count || req.query.count || '1', 10) || 1, 100));
      const resolved = EconomyController.resolveShopItem(req);
      const item = resolved.item;
      if (!item) return res.status(404).json({ error: 'GASHA_NOT_FOUND' });

      const price = EconomyController.getPriceForItem(item, resolved.config?.fallbackPrice || null);
      const totalCost = {
        amount: Number(price.amount || 0) * requestedCount,
        currency: price.currency
      };
      const balance = UserModel.getBalanceAmount(user, totalCost.currency);
      if (balance < totalCost.amount) return res.status(402).json({ error: 'INSUFFICIENT_FUNDS' });

      if (totalCost.amount > 0) {
        await UserModel.removeBalance(user.deviceId, totalCost.currency, totalCost.amount);
      }

      const normalizedRewards = EconomyController.normalizeRewards(item);
      const rollCount = Math.max(1, Number(item.RollCount || item.rollCount || 1));
      const rewards = [];
      for (let purchaseIndex = 0; purchaseIndex < requestedCount; purchaseIndex++) {
        for (let i = 0; i < rollCount; i++) {
          const chosen = EconomyController.chooseReward(normalizedRewards);
          const granted = await EconomyController.applyReward(user, chosen);
          if (granted) rewards.push(granted);
        }
      }

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      const legacyRewards = rewards.map(r => r?.legacy || toLegacyRewardPayload(r, r?.cosmeticId)).filter(Boolean);
      const unlockedItems = rewards.map(r => r?.cosmetic).filter(Boolean);
      res.json({
        success: true,
        user: updatedUser,
        User: updatedUser,
        rewards: legacyRewards,
        rawRewards: rewards,
        Rewards: legacyRewards,
        unlockedItems,
        Items: unlockedItems,
        gashaId: item.Name || item.name || resolved.itemId,
        purchaseCount: requestedCount,
        spent: totalCost
      });
    } catch (err) {
      Console.error('Economy', 'Gasha error:', err);
      res.status(err.statusCode || 500).json({ error: err.message || 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async getLuckySpin(req, res) {
    try {
      const wheelType = req.params.wheelType || req.query.type || 'lucky';
      const { config, item } = EconomyController.resolveWheelItem(wheelType);
      const luckyShopConfig = (SharedData.ShopDef || {}).LuckySpinWheel || null;
      const user = req.user || null;
      const currentUser = user ? await UserModel.findByStumbleId(user.stumbleId) : null;
      const price = EconomyController.getPriceForItem(item, config.fallbackPrice);

      const wheelItems = buildWheelDisplayRewards(config, item).slice(0, 64);
      res.json({
        success: true,
        wheelType: config.id,
        wheelName: config.displayName,
        itemName: item?.Name || item?.name || config.itemName,
        price,
        balances: currentUser ? {
          gems: UserModel.getBalanceAmount(currentUser, 'gems'),
          freeSpins: UserModel.getBalanceAmount(currentUser, 'default_free_spins'),
          adSpins: UserModel.getBalanceAmount(currentUser, 'default_free_ad_spins')
        } : null,
        luckySpinConfig: config.shopConfig || luckyShopConfig || null,
        LuckySpinConfig: config.shopConfig || luckyShopConfig || null,
        LuckySpinWheel: config.shopConfig || luckyShopConfig || null,
        rewardsPreview: wheelItems,
        RewardsPreview: wheelItems,
        wheelItems,
        WheelItems: wheelItems
      });
    } catch (err) {
      Console.error('Economy', 'GetLuckySpin error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }


  static async getGashaInfo(req, res) {
    try {
      const resolved = EconomyController.resolveShopItem(req);
      const item = resolved.item;
      if (!item) return res.status(404).json({ error: 'GASHA_NOT_FOUND' });
      const user = req.user || null;
      const currentUser = user ? await UserModel.findByStumbleId(user.stumbleId) : null;
      const fallbackPrice = resolved.config?.fallbackPrice || null;
      const price = EconomyController.getPriceForItem(item, fallbackPrice);
      const rewardsPreview = EconomyController.normalizeRewards(item).slice(0, 128).map(reward => ({
        type: reward.rawType,
        amount: reward.amount,
        currencyType: reward.currencyType,
        cosmeticId: reward.cosmeticId,
        rarity: reward.rarity,
        chance: reward.chance
      }));
      return res.json({
        success: true,
        itemName: item?.Name || item?.name || resolved.itemId,
        price,
        balances: currentUser ? {
          gems: UserModel.getBalanceAmount(currentUser, 'gems'),
          coins: UserModel.getBalanceAmount(currentUser, 'coins')
        } : null,
        rewardsPreview,
        RewardsPreview: rewardsPreview,
        item,
        Item: item
      });
    } catch (err) {
      Console.error('Economy', 'GetGashaInfo error:', err);
      return res.status(500).json({ error: err.message || 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async purchaseLuckySpin(req, res) {
    try {
      if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
      const user = (await UserModel.findByStumbleId(req.user.stumbleId)) || req.user;
      const wheelType = req.params.wheelType || req.query.type || 'lucky';
      const { config, item } = EconomyController.resolveWheelItem(wheelType);
      if (!item) return res.status(404).json({ error: 'SPIN_NOT_CONFIGURED' });

      const price = EconomyController.getPriceForItem(item, config.fallbackPrice);
      const spendCurrency = await EconomyController.spendWheelPrice(user, price, !!config.isLuckySpin, req.spinType);
      const chosenReward = EconomyController.chooseReward(EconomyController.normalizeRewards(item));
      const reward = await EconomyController.applyReward(user, chosenReward);
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      res.json(EconomyController.formatWheelResponse({
        config,
        item,
        price,
        spendCurrency,
        reward,
        updatedUser
      }));
    } catch (err) {
      Console.error('Economy', 'Spin error:', err);
      res.status(err.statusCode || 500).json({ error: err.message || 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async giveCurrency(req, res) {
    try {
      const { currencyType, amount } = req.params;
      const { user } = req;

      const normalizedCurrency = normalizeCurrencyName(currencyType);
      const validCurrencies = ['gems', 'coins', 'dust', 'default_free_spins', 'default_free_ad_spins', 'aec', 'aes', 'stumble_coins'];
      if (!validCurrencies.includes(normalizedCurrency)) {
        return res.status(400).json({ error: 'INVALID_CURRENCY' });
      }

      const parsedAmount = parseInt(amount);
      if (isNaN(parsedAmount)) {
        return res.status(400).json({ error: 'INVALID_AMOUNT' });
      }

      await UserModel.addBalance(user.deviceId, normalizedCurrency, parsedAmount);
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      res.json({
        success: true,
        user: updatedUser,
        currencyAdded: {
          type: normalizedCurrency,
          amount: parsedAmount
        }
      });
    } catch (err) {
      Console.error('Economy', 'GiveCurrency error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }
}
class AnalyticsController {
  static async analytic(req, res) {
    try {
      const { user } = req;
      const { type, message } = req.body;

      if (!type || !message) {
        return res.status(400).json({ message: 'Type and message are required' });
      }

      await database.collections.Analytics.insertOne({
        DeviceId: user.deviceId,
        type,
        message,
        timestamp: new Date()
      });

      res.status(200).json("OK");
    } catch (err) {
      Console.error("Analytics", "Error:", err);
      res.status(500).json("Error");
    }
  }
}

class FriendsController {
  static async add(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!UserId) {
        return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      }

      const friend = await UserModel.findById(UserId);
      if (!friend) {
        return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      }

      if (user.friends.includes(friend.stumbleId)) {
        return res.status(409).json({ ResultCode: -1, Message: 'Already friends' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $addToSet: { friends: friend.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: friend.stumbleId },
        { $addToSet: { friends: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      return res.status(200).json({
        ResultCode: 1,
        User: updatedUser.userProfile
      });

    } catch (err) {
      Console.error('Friends', 'Add error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async request(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!UserId) {
        return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      }

      const toUser = await UserModel.findById(UserId);
      if (!toUser) {
        return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      }

      if (user.sentFriendRequests.includes(toUser.stumbleId)) {
        return res.status(409).json({ ResultCode: -1, Message: 'Request already sent' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $addToSet: { sentFriendRequests: toUser.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: toUser.stumbleId },
        { $addToSet: { receivedFriendRequests: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      return res.status(200).json({
        ResultCode: 1,
        User: updatedUser.userProfile
      });

    } catch (err) {
      Console.error('Friends', 'Request error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async accept(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!UserId) {
        return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      }

      const fromUser = await UserModel.findById(UserId);
      if (!fromUser) {
        return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      }

      if (!user.receivedFriendRequests.includes(fromUser.stumbleId)) {
        return res.status(404).json({ ResultCode: -1, Message: 'No friend request found' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        {
          $pull: { receivedFriendRequests: fromUser.stumbleId },
          $addToSet: { friends: fromUser.stumbleId }
        }
      );

      await database.collections.Users.updateOne(
        { stumbleId: fromUser.stumbleId },
        {
          $pull: { sentFriendRequests: user.stumbleId },
          $addToSet: { friends: user.stumbleId }
        }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      return res.status(200).json({
        ResultCode: 1,
        User: updatedUser.userProfile
      });

    } catch (err) {
      Console.error('Friends', 'Accept error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async reject(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!UserId) {
        return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      }

      const fromUser = await UserModel.findById(UserId);
      if (!fromUser) {
        return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      }

      if (!user.receivedFriendRequests.includes(fromUser.stumbleId)) {
        return res.status(404).json({ ResultCode: -1, Message: 'No friend request found' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $pull: { receivedFriendRequests: fromUser.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: fromUser.stumbleId },
        { $pull: { sentFriendRequests: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      return res.status(200).json({
        ResultCode: 1,
        User: updatedUser.userProfile
      });

    } catch (err) {
      Console.error('Friends', 'Reject error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async cancel(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;

      if (!UserId) {
        return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      }

      const toUser = await UserModel.findById(UserId);
      if (!toUser) {
        return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      }

      if (!user.sentFriendRequests.includes(toUser.stumbleId)) {
        return res.status(404).json({ ResultCode: -1, Message: 'No friend request found' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $pull: { sentFriendRequests: toUser.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: toUser.stumbleId },
        { $pull: { receivedFriendRequests: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      return res.status(200).json({
        ResultCode: 1,
        User: updatedUser.userProfile
      });

    } catch (err) {
      Console.error('Friends', 'Cancel error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async list(req, res) {
    try {
      const { user } = req;

      const friends = await database.collections.Users.find({
        stumbleId: { $in: user.friends || [] }
      }).project({
        userProfile: 1
      }).toArray();

      return res.status(200).json(friends.map(f => f.userProfile));
    } catch (err) {
      Console.error('Friends', 'List error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async pending(req, res) {
    try {
      const { user } = req;

      const pendingUsers = await database.collections.Users.find({
        stumbleId: { $in: user.receivedFriendRequests || [] }
      }).project({
        userProfile: 1
      }).toArray();

      return res.status(200).json(pendingUsers.map(u => u.userProfile));
    } catch (err) {
      Console.error('Friends', 'Pending error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async remove(req, res) {
    try {
      const { UserId } = req.params;
      const { user } = req;

      if (!UserId) {
        return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      }

      const friend = await UserModel.findById(UserId);
      if (!friend) {
        return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      }

      if (!user.friends.includes(friend.stumbleId)) {
        return res.status(404).json({ ResultCode: -1, Message: 'Not friends' });
      }

      await database.collections.Users.updateOne(
        { stumbleId: user.stumbleId },
        { $pull: { friends: friend.stumbleId } }
      );

      await database.collections.Users.updateOne(
        { stumbleId: friend.stumbleId },
        { $pull: { friends: user.stumbleId } }
      );

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);

      return res.status(200).json({
        ResultCode: 1,
        User: updatedUser.userProfile
      });

    } catch (err) {
      Console.error('Friends', 'Remove error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async search(req, res) {
    try {
      const { UserName } = req.body;

      if (!UserName || UserName.length < 3) {
        return res.status(400).json({ ResultCode: -1, Message: 'UserName must be at least 3 characters' });
      }

      const user = await database.collections.Users.findOne({
        username: { $regex: UserName, $options: 'i' }
      }).project({
        userProfile: 1
      });

      if (!user) {
        return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      }

      return res.status(200).json({
        ResultCode: 1,
        User: user.userProfile
      });
    } catch (err) {
      Console.error('Friends', 'Search error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }
}

class NewsController {
  static async GetNews(req, res) {
    try {
      const newsList = await database.collections.News
        .find()
        .sort({ timestamp: -1 })
        .toArray();

      const news = newsList.map(news => ({
        Header: news.header,
        Message: news.message,
        TimeStamp: news.timestamp
      }));

      res.json(news);
    } catch (err) {
      Console.error('News', 'Get error:', err);
      res.status(500).json({ message: 'Error fetching news' });
    }
  }
}

class MissionsController {
  static async getMissions(req, res) {
    try {
      const { user } = req;

      const missions = SharedData.MissionObjectives.map(mission => ({
        missionId: mission.Id,
        missionActive: true,
        rewardsClaimed: false,
        requirementProgressions: mission.Requirements.map(req => ({
          requirementId: req.Id,
          completed: Math.random() > 0.5,
          current: Math.floor(Math.random() * req.Target),
          target: req.Target
        }))
      }));

      res.json({
        missionObjectiveProgressionUpdated: {
          missionObjectiveId: "daily",
          currentPoints: Math.floor(Math.random() * 100),
          milestoneProgressions: SharedData.MissionObjectives
            .find(m => m.Id === "daily")?.Milestones.map(milestone => ({
              milestoneId: milestone.MilestoneId,
              claimed: false
            })) || []
        },
        missionsProgressionsUpdated: missions
      });
    } catch (err) {
      Console.error('Missions', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimMissionReward(req, res) {
    try {
      const { user } = req;
      const { missionId } = req.params;

      const mission = SharedData.MissionObjectives
        .flatMap(m => m.Requirements.map(r => ({ ...r, missionId: m.Id })))
        .find(m => m.missionId === missionId);

      if (!mission) {
        return res.status(404).json({ message: 'Mission not found' });
      }

      const rewards = mission.Rewards || [];
      for (const reward of rewards) {
        if (reward.type === 'CURRENCY') {
          await UserModel.addBalance(user.deviceId, reward.typeInfo, reward.amount);
        }
      }

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({
        User: updatedUser,
        Rewards: rewards,
        message: 'Rewards claimed successfully'
      });
    } catch (err) {
      Console.error('Missions', 'Claim error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimMilestoneReward(req, res) {
    try {
      const { user } = req;
      const { objectiveId, milestoneId } = req.params;

      const objective = SharedData.MissionObjectives.find(m => m.Id === objectiveId);
      if (!objective) {
        return res.status(404).json({ message: 'Objective not found' });
      }

      const milestone = objective.Milestones.find(m => m.MilestoneId === milestoneId);
      if (!milestone) {
        return res.status(404).json({ message: 'Milestone not found' });
      }

      const rewards = milestone.Rewards || [];
      for (const reward of rewards) {
        if (reward.type === 'CURRENCY') {
          await UserModel.addBalance(user.deviceId, reward.typeInfo, reward.amount);
        }
      }

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({
        User: updatedUser,
        Rewards: rewards,
        message: 'Milestone rewards claimed successfully'
      });
    } catch (err) {
      Console.error('Missions', 'Claim milestone error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class TournamentXController {
  static tournaments = [
    {
      id: 1,
      type: 1,
      isEnabled: true,
      minVersion: "0.56",
      startTime: new Date(),
      endTime: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      nameKey: "Lz League 1v1 BD Tounament",
      descriptionKey: "Block Dash Tournament! Play 1v1 with random enemies!",
      listItemBackgroundImage: "Premium_LBD_Background_Image_Tournaments_Card",
      detailsPanelBackgroundImage: "Premium_LBD_Background_Image_Tournaments",

      prizeBannerColour: "#FF6A00",
      headerColour: "#FF6A00",
      mapListGradientColourTop: "#FF6A00",
      mapListGradientColourBottom: "#FF9A00",

      listPriority: 1,
      minPlayers: 2,
      maxPlayers: 2,
      maxRounds: 1,
      minMatchmakingSeconds: 2,
      entryCurrencyType: "gems",
      entryCurrencyCost: 0,
      areEmotesRestricted: false,
      prohibitedEmotes: [8, 13, 55, 122, 123, 124],

      detailsPanelBorderColourTop: "#FF6A00",
      detailsPanelBorderColourBottom: "#FF9A00",

      colourData: {
        detailsPanelMainColour: "#FF7F00",
        detailsPanelBorderColour: "#FF9A00",
        headerGradientRight: "#FF6A00",
        headerGradientLeft: "#FFB000",
        infoWidgetsGradientRight: "#FF7F00",
        infoWidgetsGradientLeft: "#FF6A00",
        infoWidgetsBorderColour: "#FF9A00"
      },

      rounds: [
        {
          roundOrder: 1,
          maxPlayersToProgress: 1,
          minPlayersPerMatch: 2,
          maxPlayersPerMatch: 2,
          areLevelsRestricted: true,
          permittedLevels: ["level19_block"]
        }
      ],

      awards: [
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 1, type: "XP", amount: 200 },
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 2, type: "TROPHIES", amount: 15 },
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 3, type: "TOURNAMENTXP", amount: 50 },
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 4, type: "CROWNS", amount: 1 }
      ],

      players: [],
      partys: []
    },

    {
      id: 2,
      type: 1,
      isEnabled: true,
      minVersion: "0.56",
      startTime: new Date(),
      endTime: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000),
      nameKey: "Lz League 1v1 Laser Dash Tounament",
      descriptionKey: "Laser Dash Tournament! Play 1v1 with random enemies!",
      listItemBackgroundImage: "Event_Lobby_Item_Background_eventlevel1_dash",
      detailsPanelBackgroundImage: "Monopoly_Background_Tournaments",

      prizeBannerColour: "#FF6A00",
      headerColour: "#FF6A00",
      mapListGradientColourTop: "#FF6A00",
      mapListGradientColourBottom: "#FF9A00",

      listPriority: 0,
      minPlayers: 2,
      maxPlayers: 2,
      maxRounds: 1,
      minMatchmakingSeconds: 2,
      entryCurrencyType: "gems",
      entryCurrencyCost: 0,
      areEmotesRestricted: false,
      prohibitedEmotes: [7],

      detailsPanelBorderColourTop: "#FF6A00",
      detailsPanelBorderColourBottom: "#FF9A00",

      colourData: {
        detailsPanelMainColour: "#FF7F00",
        detailsPanelBorderColour: "#FF9A00",
        headerGradientRight: "#FF6A00",
        headerGradientLeft: "#FFB000",
        infoWidgetsGradientRight: "#FF7F00",
        infoWidgetsGradientLeft: "#FF6A00",
        infoWidgetsBorderColour: "#FF9A00"
      },

      rounds: [
        {
          roundOrder: 1,
          maxPlayersToProgress: 1,
          minPlayersPerMatch: 2,
          maxPlayersPerMatch: 2,
          areLevelsRestricted: true,
          permittedLevels: ["eventlevel1_dash"]
        }
      ],

      awards: [ 
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 1, type: "XP", amount: 200 },
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 2, type: "TROPHIES", amount: 15 },
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 3, type: "TOURNAMENTXP", amount: 50 },
        { placementRangeLowest: 1, placementRangeHighest: 1, awardId: 4, type: "CROWNS", amount: 1 }
      ],

      players: [],
      partys: []
    }
  ];

  // Remove o jogador da lista do torneio e de qualquer fila de partida (party).
  // Retorna true se ele estava no torneio.
  static removePlayer(tournament, stumbleId) {
    const wasIn = tournament.players.some(p => p.stumbleId === stumbleId);
    tournament.players = tournament.players.filter(p => p.stumbleId !== stumbleId);
    if (!Array.isArray(tournament.partys)) tournament.partys = [];
    for (const list of tournament.partys) {
      for (const party of list) {
        party.players = party.players.filter(id => id !== stumbleId);
      }
    }
    TournamentXController.cleanParties(tournament);
    return wasIn;
  }

  // Apaga filas vazias, filas incompletas paradas há mais de 90s (jogador fechou o jogo sem sair)
  // e filas antigas (30 min).
  static cleanParties(tournament) {
    const now = Date.now();
    const maxPlayers = tournament.maxPlayers || 2;
    tournament.partys = (tournament.partys || [])
      .map(list => list.filter(p => {
        if (p.players.length === 0) return false;
        const age = now - (p.updatedAt || p.createdAt || now);
        if (p.players.length < maxPlayers && age > 90 * 1000) return false;
        if (age > 30 * 60 * 1000) return false;
        return true;
      }))
      .filter(list => list.length > 0);
    // Mantém a lista de jogadores coerente com as filas
    const inParties = new Set(tournament.partys.flatMap(l => l.flatMap(p => p.players)));
    tournament.players = tournament.players.filter(p => inParties.has(p.stumbleId));
  }

  static getActive(req, res) {
    try {
      // Não expõe jogadores/filas internas para o cliente
      const list = TournamentXController.tournaments.map(t => ({ ...t, players: [], partys: [] }));
      res.status(200).json(list);
    } catch (err) {
      console.error("erro:", err);
      res.status(500).json({ message: "erro interno" });
    }
  }

  static async join(req, res) {
    try {
      const { user } = req;
      if (!user || !user.stumbleId) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      const tournamentId = parseInt(req.params.tournamentId);
      const tournament = TournamentXController.tournaments.find(t => t.id === tournamentId);

      if (!tournament) {
        return res.status(404).json({ message: "torneio nao encontrado" });
      }

      // Se o jogador já estava em alguma fila (entrou de novo sem sair), tira ele antes
      // e não cobra a entrada duas vezes.
      TournamentXController.cleanParties(tournament);
      const alreadyIn = TournamentXController.removePlayer(tournament, user.stumbleId);

      if (!tournament.isEnabled) {
        return res.status(400).json({ message: "torneio desativado" });
      }

      const now = new Date();
      if (now < tournament.startTime || now > tournament.endTime) {
        return res.status(400).json({ message: "torneio nao esta ativo no momento" });
      }

      if (tournament.entryCurrencyCost > 0 && !alreadyIn) {
        const userBalance = UserModel.getBalanceAmount(user, tournament.entryCurrencyType);
        if (userBalance < tournament.entryCurrencyCost) {
          return res.status(400).json({
            message: `saldo insuficiente de ${tournament.entryCurrencyType}`
          });
        }

        await UserModel.removeBalance(user.deviceId, tournament.entryCurrencyType, tournament.entryCurrencyCost);
      }

      tournament.players.push({
        stumbleId: user.stumbleId,
        userId: user.id,
        username: user.username
      });

      const entryToken = `tournament-${tournament.id}-${Date.now()}`;
      const expiryDate = tournament.endTime.toISOString();

      const maps = [];
      const roundsQualified = [];

      if (Array.isArray(tournament.rounds)) {
        for (const round of tournament.rounds) {
          if (Array.isArray(round.permittedLevels)) {
            round.permittedLevels.forEach(lvl => maps.push({ id: lvl }));
          }
          if (round.maxPlayersToProgress) {
            roundsQualified.push(round.maxPlayersToProgress);
          }
        }
      }

      if (!Array.isArray(tournament.partys)) {
        tournament.partys = [];
      }

      const maxPlayers = tournament.maxPlayers || 2;
      let partyId;
      let MatchmakerTag;
      let found = false;

      for (const partyList of tournament.partys) {
        for (const party of partyList) {
          if (party.players.length < maxPlayers) {
            party.players.push(user.stumbleId);
            party.updatedAt = Date.now();
            MatchmakerTag = party.partyId;
            partyId = party.partyId;
            found = true;
            break;
          }
        }
        if (found) break;
      }

      if (!found) {
        const newParty = {
          partyId: `tournament-${tournament.id}-${Math.floor(Math.random() * 9999)}-${Date.now().toString(36)}`,
          players: [user.stumbleId],
          createdAt: Date.now(),
          updatedAt: Date.now()
        };
        tournament.partys.push([newParty]);
        MatchmakerTag = newParty.partyId;
        partyId = newParty.partyId;
      }

      const response = {
        entryToken,
        MatchmakerTag,
        requestId: user.stumbleId
      };

      console.log(`coloquei o ${user.username} na partida ${partyId} no torneio ${tournament.nameKey} com id ${tournament.id} e token ${entryToken}`);
      res.status(200).json(response);
    } catch (err) {
      console.error("erro ao entrar no torneio:", err);
      res.status(500).json({ message: "erro interno do servidor" });
    }
  }

  static async leave(req, res) {
    try {
      const { user } = req;
      if (!user || !user.stumbleId) {
        return res.status(401).json({ message: "Unauthorized" });
      }
      const tournamentId = parseInt(req.params.tournamentId);
      const tournament = TournamentXController.tournaments.find(t => t.id === tournamentId);

      if (!tournament) {
        return res.status(404).json({ message: "torneio nao encontrado" });
      }

      // Tira o jogador da lista E da fila de partida (antes só saía da lista e a fila ficava com "fantasma")
      const wasIn = TournamentXController.removePlayer(tournament, user.stumbleId);
      if (wasIn && tournament.entryCurrencyCost > 0) {
        await UserModel.addBalance(user.deviceId, tournament.entryCurrencyType, tournament.entryCurrencyCost);
      }

      res.status(200).json({ message: "saiu" });
    } catch (err) {
      console.error("tournamentx", "erro ao sair do torneio:", err);
      res.status(500).json({ message: "erro interno do servidor" });
    }
  }

  static async finish(req, res) {
    try {
      const body = req.body || {};
      const { Round, TournamentId, EntryToken, SignedPayload } = body;
      const user = req.user;

      if (Round === undefined || Round === null || Round === "") {
        return res.status(400).json({ message: "Round is required", mensagem: "precisa do round" });
      }
      if (!user || !user.stumbleId || !user.userProfile) {
        return res.status(401).json({ message: "Unauthorized", mensagem: "user invalido" });
      }

      const roundResult = Number.parseInt(Round, 10);
      if (!Number.isFinite(roundResult) || ![0, 1].includes(roundResult)) {
        return res.status(400).json({ message: "Invalid tournament round", mensagem: "round invalido" });
      }

      // O TournamentX é uma partida única: 1 = vitória, 0 = derrota.
      const rewards = {
        gems: roundResult === 1 ? 60 : 0,
        crowns: roundResult === 1 ? 1 : 0,
        trophies: roundResult === 1 ? 10 : -10,
        skillRating: roundResult === 1 ? 10 : -10
      };

      const currentCrowns = Number.parseInt(user.userProfile.crowns, 10) || 0;
      const currentTrophies = Number.parseInt(user.userProfile.trophies, 10) || 0;
      const currentSkill = Number.parseInt(user.skillRating, 10) || 0;

      const updatedUserProfile = {
        ...user.userProfile,
        crowns: Math.max(0, currentCrowns + rewards.crowns),
        trophies: Math.max(0, currentTrophies + rewards.trophies)
      };

      await UserModel.update(user.stumbleId, {
        crowns: updatedUserProfile.crowns,
        skillRating: Math.max(0, currentSkill + rewards.skillRating),
        userProfile: updatedUserProfile
      });

      if (rewards.gems > 0) {
        await UserModel.addBalance(user.deviceId, "gems", rewards.gems);
      }

      // Limpa a participação/fila após a partida para não deixar o jogador preso
      // numa party antiga quando o cliente voltar ao lobby e procurar outro torneio.
      const tournamentId = Number.parseInt(TournamentId, 10);
      const tournament = TournamentXController.tournaments.find(t => t.id === tournamentId);
      if (tournament) {
        TournamentXController.removePlayer(tournament, user.stumbleId);
      }

      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      const responseUser = updatedUser || {
        ...user,
        crowns: updatedUserProfile.crowns,
        skillRating: Math.max(0, currentSkill + rewards.skillRating),
        userProfile: updatedUserProfile
      };

      console.log(`[TournamentX] Partida finalizada: user=${user.stumbleId}, tournament=${TournamentId ?? "unknown"}, round=${roundResult}`);

      // Mantém os campos do endpoint antigo e inclui os campos de resultado/recompensas
      // que o cliente pode esperar ao finalizar uma partida.
      return res.status(200).json({
        TournamentId: TournamentId ?? null,
        Round: roundResult,
        EntryToken: EntryToken ?? null,
        SignedPayload: SignedPayload ?? "",
        CollectedCurrencies: rewards.gems > 0 ? { gems: rewards.gems } : {},
        User: responseUser,
        Rewards: {
          gems: rewards.gems,
          crowns: rewards.crowns,
          trophies: Math.max(0, rewards.trophies),
          skillRating: Math.max(0, rewards.skillRating)
        },
        Success: true
      });
    } catch (err) {
      console.error("[TournamentX] Erro ao finalizar partida:", err);
      if (!res.headersSent) {
        return res.status(500).json({ message: "Failed to finish TournamentX match", mensagem: "erro interno do servidor" });
      }
    }
  }

  static getSeasons(req, res) {
    res.status(200).json([]);
  }

  static async getSeasonProgress(req, res) {
    res.status(200).json({
      seasonId: 1,
      userId: req.user?.id || 0,
      xp: 0,
      claimedAwards: []
    });
  }

  static async claimSeasonReward(req, res) {
    res.status(200).json({
      User: req.user,
      Rewards: []
    });
  }
}

class MatchmakingController {
  static async getMatchmakingFilter(req, res) {
    try {
      const { deviceId } = req.query;

      if (!deviceId) {
        return res.status(400).json({
          error: "Bad Request",
          message: "deviceId query parameter is required"
        });
      }

      const user = await UserModel.findByDeviceId(deviceId);

      if (!user) {
        return res.status(404).json({
          error: "Not Found",
          message: "User not found"
        });
      }

      const sharedType = process.env.sharedType || 'NULL';
      const version = user.version || '0';
      const platform = user.userProfile?.nativePlatformName || 'null';
      const skillTier = Math.floor((user.skillRating || 0) / 1000);
      const regionCodes = ['na', 'eu', 'as', 'sa', 'af', 'oc', 'ae'];
      const region = regionCodes[Math.floor(Math.random() * regionCodes.length)];

      const matchmakingFilter = `${sharedType}_${version}_${platform}_${skillTier}_${region}`;

      return res.status(200).json({ matchmakingFilter });

    } catch (err) {
      Console.error('Matchmaking', 'Filter error:', err);
      return res.status(500).json({
        error: "Internal Server Error",
        message: "An error occurred while generating matchmaking filter"
      });
    }
  }
}


class SocialController {
  static async getInteractions(req, res) {
    try {
      const { user } = req;

      const friendIds = user.friends || [];
      const friends = await database.collections.Users.find({ stumbleId: { $in: friendIds } })
        .project({
          id: 1,
          username: 1,
          stumbleId: 1,
          country: 1,
          skillRating: 1,
          crowns: 1,
          experience: 1,
          'equippedCosmetics.skin': 1,
          lastLogin: 1
        })
        .toArray();

      const friendProfiles = friends.map(friend => ({
        userId: friend.id,
        userName: friend.username,
        title: "",
        country: friend.country,
        trophies: friend.skillRating,
        crowns: friend.crowns,
        experience: friend.experience,
        hiddenRating: Math.floor(friend.skillRating / 10),
        isOnline: true,
        lastSeenDate: friend.lastLogin.toISOString(),
        skin: friend.equippedCosmetics?.skin || 'SKIN1',
        nativePlatformName: "android",
        ranked: {
          currentSeasonId: "LIVE_RANKED_SEASON_0",
          currentRankId: 1,
          currentTierIndex: 0
        },
        flags: 0
      }));


      const receivedRequests = user.receivedFriendRequests || [];
      const pendingUsers = await database.collections.Users.find({
        stumbleId: { $in: receivedRequests }
      }).project({
        id: 1,
        username: 1,
        country: 1,
        skillRating: 1,
        crowns: 1,
        experience: 1,
        'equippedCosmetics.skin': 1,
        lastLogin: 1
      }).toArray();

      const friendRequestProfiles = pendingUsers.map(u => ({
        userId: u.id,
        userName: u.username,
        title: "",
        country: u.country,
        trophies: u.skillRating,
        crowns: u.crowns,
        experience: u.experience,
        hiddenRating: Math.floor(u.skillRating / 10),
        isOnline: true,
        lastSeenDate: u.lastLogin.toISOString(),
        skin: u.equippedCosmetics?.skin || 'SKIN1',
        nativePlatformName: "android",
        ranked: {
          currentSeasonId: "LIVE_RANKED_SEASON_0",
          currentRankId: 1,
          currentTierIndex: 0
        },
        flags: 0
      }));


      const recommendedUsers = await database.collections.Users.aggregate([
        { $match: {
          stumbleId: { $nin: [...friendIds, ...receivedRequests, user.stumbleId] },
          country: { $exists: true }
        }},
        { $sample: { size: 5 } },
        { $project: {
          id: 1,
          username: 1,
          country: 1,
          skillRating: 1,
          crowns: 1,
          experience: 1,
          'equippedCosmetics.skin': 1,
          lastLogin: 1
        }}
      ]).toArray();

      const recommendedProfiles = recommendedUsers.map(u => {
        const tags = [];
        if (u.country === user.country) tags.push("SAME_COUNTRY");
        if (Math.abs((u.skillRating || 0) - (user.skillRating || 0)) < 200) tags.push("SIMILAR_SKILL");

        return {
          tags: tags.length > 0 ? tags : ["SIMILAR_SKILL"],
          userProfile: {
            userId: u.id,
            userName: u.username,
            title: "",
            country: u.country,
            trophies: u.skillRating,
            crowns: u.crowns,
            experience: u.experience,
            hiddenRating: Math.floor(u.skillRating / 10),
            isOnline: true,
            lastSeenDate: u.lastLogin.toISOString(),
            skin: u.equippedCosmetics?.skin || 'SKIN1',
            nativePlatformName: "android",
            ranked: {
              currentSeasonId: "LIVE_RANKED_SEASON_0",
              currentRankId: 1,
              currentTierIndex: 0
            },
            flags: 0
          }
        };
      });

      res.json({
        friends: friendProfiles,
        friendRequests: friendRequestProfiles,
        partyInvites: [],
        recommendedFriends: recommendedProfiles
      });
    } catch (err) {
      Console.error('Social', 'Interactions error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}


class TournamentController {
    static async login(req, res) {
        try {
            const user = await UserModel.findByDeviceId(req.user.deviceId);
            const photonJwt = await generatePhotonJwt(user);

            return res.json({
                User: user,
                PhotonJwt: photonJwt,
                equippedCosmetics: user.equippedCosmetics
            });

        } catch (error) {
            Console.error('TournamentLogin', error);
            return res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async createTournament(req, res) {
        try {
            const { name, description, startTime, endTime, entryFee, maxPlayers, rewards } = req.body;

            if (!name || !startTime || !endTime) {
                return res.status(400).json({ message: 'Name, startTime and endTime are required' });
            }

            const tournament = {
                id: uuidv4(),
                name,
                description: description || "",
                startTime: new Date(startTime),
                endTime: new Date(endTime),
                entryFee: entryFee || 0,
                maxPlayers: maxPlayers || 1000,
                currentPlayers: 0,
                rewards: rewards || [],
                createdAt: new Date(),
                updatedAt: new Date(),
                isActive: true
            };

            const result = await database.collections.Tournaments.insertOne(tournament);

            if (result.acknowledged) {
                res.status(201).json({
                    message: 'Tournament created successfully',
                    tournament
                });
            } else {
                throw new Error('Failed to create tournament');
            }
        } catch (err) {
            Console.error('Tournament', 'Create error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async getActive(req, res) {
        try {
            const now = new Date();
            const activeTournaments = await database.collections.Tournaments.find({
                startTime: { $lte: now },
                endTime: { $gte: now },
                isActive: true
            }).sort({ startTime: 1 }).toArray();

            res.json(activeTournaments);
        } catch (err) {
            Console.error('Tournament', 'Get active error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async getTournamentById(req, res) {
        try {
            const { id } = req.params;

            if (!id) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({ id });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            res.json(tournament);
        } catch (err) {
            Console.error('Tournament', 'Get by ID error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async joinTournament(req, res) {
        try {
            const { user } = req;
            const { tournamentId } = req.params;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({
                id: tournamentId,
                isActive: true
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found or inactive' });
            }

            const now = new Date();
            if (now < tournament.startTime) {
                return res.status(400).json({ message: 'Tournament has not started yet' });
            }

            if (tournament.currentPlayers >= tournament.maxPlayers) {
                return res.status(400).json({ message: 'Tournament is full' });
            }

            const existingParticipation = await database.collections.TournamentParticipants.findOne({
                tournamentId,
                userId: user.id
            });

            if (existingParticipation) {
                return res.status(400).json({ message: 'You have already joined this tournament' });
            }

            if (tournament.entryFee > 0) {
                const userBalance = UserModel.getBalanceAmount(user, 'gems');
                if (userBalance < tournament.entryFee) {
                    return res.status(400).json({ message: 'Not enough gems to join tournament' });
                }

                await UserModel.removeBalance(user.stumbleId, 'gems', tournament.entryFee);
            }

            await database.collections.TournamentParticipants.insertOne({
                id: uuidv4(),
                tournamentId,
                userId: user.id,
                username: user.username,
                joinTime: new Date(),
                score: 0,
                position: 0,
                rewardsClaimed: false
            });

            await database.collections.Tournaments.updateOne(
                { id: tournamentId },
                { $inc: { currentPlayers: 1 } }
            );

            res.json({
                message: 'Successfully joined tournament',
                tournamentId,
                entryFeePaid: tournament.entryFee
            });

        } catch (err) {
            Console.error('Tournament', 'Join error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async submitTournamentScore(req, res) {
        try {
            const { user } = req;
            const { tournamentId } = req.params;
            const { score } = req.body;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            if (typeof score !== 'number' || score < 0) {
                return res.status(400).json({ message: 'Invalid score' });
            }

            const tournament = await database.collections.Tournaments.findOne({
                id: tournamentId,
                isActive: true
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found or inactive' });
            }

            const participation = await database.collections.TournamentParticipants.findOne({
                tournamentId,
                userId: user.id
            });

            if (!participation) {
                return res.status(400).json({ message: 'You did not participate in this tournament' });
            }

            await database.collections.TournamentParticipants.updateOne(
                { id: participation.id },
                { $set: { score: Math.max(participation.score, score) } }
            );

            res.json({
                message: 'Score submitted successfully',
                tournamentId,
                newScore: score,
                previousScore: participation.score
            });

        } catch (err) {
            Console.error('Tournament', 'Submit score error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async getTournamentLeaderboard(req, res) {
        try {
            const { tournamentId } = req.params;
            const { limit = 50 } = req.query;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({
                id: tournamentId
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            const leaderboard = await database.collections.TournamentParticipants
                .find({ tournamentId })
                .sort({ score: -1 })
                .limit(parseInt(limit))
                .project({
                    id: 1,
                    userId: 1,
                    username: 1,
                    score: 1,
                    position: 1
                })
                .toArray();

            if (leaderboard.length > 0) {
                let currentPosition = 1;
                let previousScore = leaderboard[0].score;

                for (let i = 0; i < leaderboard.length; i++) {
                    if (leaderboard[i].score < previousScore) {
                        currentPosition = i + 1;
                        previousScore = leaderboard[i].score;
                    }
                    leaderboard[i].position = currentPosition;
                }

                await Promise.all(leaderboard.map(async (entry, index) => {
                    await database.collections.TournamentParticipants.updateOne(
                        {
                            tournamentId,
                            userId: entry.userId
                        },
                        { $set: { position: entry.position } }
                    );
                }));
            }

            res.json({
                tournamentId,
                tournamentName: tournament.name,
                leaderboard
            });

        } catch (err) {
            Console.error('Tournament', 'Leaderboard error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async claimTournamentRewards(req, res) {
        try {
            const { user } = req;
            const { tournamentId } = req.params;

            if (!tournamentId) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const tournament = await database.collections.Tournaments.findOne({
                id: tournamentId
            });

            if (!tournament) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            const now = new Date();
            if (now < tournament.endTime) {
                return res.status(400).json({ message: 'Tournament has not ended yet' });
            }

            const participation = await database.collections.TournamentParticipants.findOne({
                tournamentId,
                userId: user.id
            });

            if (!participation) {
                return res.status(400).json({ message: 'You did not participate in this tournament' });
            }

            if (participation.rewardsClaimed) {
                return res.status(400).json({ message: 'You have already claimed your rewards' });
            }

            const reward = tournament.rewards.find(r =>
                participation.position >= r.positionRangeLowest &&
                participation.position <= r.positionRangeHighest
            );

            if (!reward) {
                return res.status(400).json({ message: 'No rewards available for your position' });
            }

            switch (reward.type) {
                case 'crowns':
                    await UserModel.addBalance(user.stumbleId, 'crowns', reward.amount);
                    break;
                case 'gems':
                    await UserModel.addBalance(user.stumbleId, 'gems', reward.amount);
                    break;
                case 'skins':
                    await UserModel.addSkin(user.stumbleId, reward.skinId);
                    break;
            }

            await database.collections.TournamentParticipants.updateOne(
                { id: participation.id },
                { $set: { rewardsClaimed: true } }
            );

            res.json({
                message: 'Rewards claimed successfully',
                rewards: reward
            });

        } catch (err) {
            Console.error('Tournament', 'Claim rewards error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async updateTournament(req, res) {
        try {
            const { id } = req.params;
            const updates = req.body;

            if (!id) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            if (Object.keys(updates).length === 0) {
                return res.status(400).json({ message: 'No updates provided' });
            }

            updates.updatedAt = new Date();

            const result = await database.collections.Tournaments.updateOne(
                { id },
                { $set: updates }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            const updatedTournament = await database.collections.Tournaments.findOne({ id });

            res.json({
                message: 'Tournament updated successfully',
                tournament: updatedTournament
            });

        } catch (err) {
            Console.error('Tournament', 'Update error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }

    static async endTournament(req, res) {
        try {
            const { id } = req.params;

            if (!id) {
                return res.status(400).json({ message: 'Tournament ID is required' });
            }

            const result = await database.collections.Tournaments.updateOne(
                { id },
                {
                    $set: {
                        isActive: false,
                        endTime: new Date(),
                        updatedAt: new Date()
                    }
                }
            );

            if (result.matchedCount === 0) {
                return res.status(404).json({ message: 'Tournament not found' });
            }

            res.json({ message: 'Tournament ended successfully' });

        } catch (err) {
            Console.error('Tournament', 'End error:', err);
            res.status(500).json({ message: 'Internal server error' });
        }
    }
}

class EventsController {
  static async getActive(req, res) {
    try {
      const now = new Date();
      const activeEvents = (SharedData.GameEvents || []).filter(event => {
        const startDate = new Date(event.StartDateTime);
        const endDate = new Date(event.EndDateTime);
        return startDate <= now && now <= endDate;
      });

      res.json({ gameEvents: activeEvents});
    } catch (err) {
      Console.error('GameEvents', 'Error:', err);
      res.status(500).json([]);
    }
  }
}
function errorControll(err, req, res, next) {
  Console.error('Unhandled', 'Error:', err);
  res.status(500).json({ message: 'Internal server error' });
}

const { generateAuthPayload } = require("./SharedUtils");

async function sendShared(req, res) {
    try {
        const shared = generateAuthPayload();
        res.status(200).json(shared);
    } catch (err) {
        Console.error("sendShared", err);
        res.sendStatus(500);
    }
}

class XpRoadController {
  static async getProgress(req, res) {
    try {
      const { user } = req;
      const xpRoadData = SharedData.XpRoad || {};
      const levels = xpRoadData.Levels || [];

      const currentXp = user.experience || 0;
      let currentLevel = 1;
      for (const levelData of levels) {
        if (currentXp >= levelData.RequiredXp) {
          currentLevel = levelData.Level;
        } else {
          break;
        }
      }

      res.json({
        xpRoadId: user.xpRoad?.xpRoadId || 0,
        currentLevel,
        currentXp,
        lastClaimedLevel: user.xpRoad?.lastClaimedLevel || 1,
        isVeteran: user.xpRoad?.isVeteran || false,
        claimedRewardsIds: user.xpRoad?.claimedRewardsIds || [],
        hasBeenEnabled: true,
        currentLevelCap: user.xpRoad?.currentLevelCap || 70,
        isOnboarding: user.xpRoad?.isOnboarding || false,
        onboardingFeaturesUnlocked: user.xpRoad?.onboardingFeaturesUnlocked || []
      });
    } catch (err) {
      Console.error('XpRoad', 'Get progress error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimReward(req, res) {
    try {
      const { user } = req;
      let level = req.params.level || req.query.level || req.body?.level;
      let rewardId = req.params.rewardId || req.query.rewardId || req.body?.rewardId;

      if (!level && typeof req.body === 'string') {
        try { const parsed = JSON.parse(req.body); level = parsed.level; rewardId = parsed.rewardId; } catch (e) {}
      }

      if (!level || !rewardId) {
        return res.status(400).json({ message: 'Level and rewardId are required' });
      }

      level = parseInt(level);
      rewardId = parseInt(rewardId);

      const xpRoadData = SharedData.XpRoad || {};
      const levels = xpRoadData.Levels || [];
      const levelData = levels.find(l => l.Level === level);
      if (!levelData) return res.status(404).json({ message: 'Level not found' });

      const reward = levelData.Rewards?.find(r => r.Id === rewardId);
      if (!reward) return res.status(404).json({ message: 'Reward not found' });

      const claimedRewards = user.xpRoad?.claimedRewardsIds || [];
      if (claimedRewards.includes(rewardId)) {
        return res.status(400).json({ message: 'Reward already claimed' });
      }

      if (reward.Type === 'CURRENCY') {
        await UserModel.addBalance(user.deviceId, reward.ItemId, reward.Amount);
      } else if (reward.Type === 'SKIN') {
        await UserModel.addSkin(user.stumbleId, reward.ItemId);
      } else if (reward.Type === 'EMOTE') {
        await database.collections.Users.updateOne({ deviceId: user.deviceId }, { $addToSet: { emotes: reward.ItemId } });
      } else if (reward.Type === 'ANIMATION') {
        await database.collections.Users.updateOne({ deviceId: user.deviceId }, { $addToSet: { animations: reward.ItemId } });
      }

      await database.collections.Users.updateOne(
        { deviceId: user.deviceId },
        { $addToSet: { 'xpRoad.claimedRewardsIds': rewardId }, $set: { 'xpRoad.lastClaimedLevel': level } }
      );

      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      Console.log('XpRoad', `Reward ${rewardId} claimed for level ${level}`);
      return res.json({ User: updatedUser });
    } catch (err) {
      Console.error('XpRoad', 'Claim reward error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

async function OnlineCheck(req, res) {
  res.status(200).send("OK");
}

module.exports = {
  BackendUtils,
  Database,
  database,
  UserModel,
  UserController,
  RoundController,
  BattlePassController,
  EconomyController,
  AnalyticsController,
  FriendsController,
  NewsController,
  MissionsController,
  TournamentXController,
  MatchmakingController,
  TournamentController,
  SocialController,
  EventsController,
  authenticate,
  errorControll,
  sendShared,
  OnlineCheck,
  VerifyPhoton,
  generatePhotonJwt
};
