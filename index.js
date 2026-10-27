require("dotenv").config();
const express = require("express");
const Console = require("./ConsoleUtils");
const CryptoUtils = require("./CryptoUtils");
const SharedUtils = require("./SharedUtils");

const {
  BackendUtils,
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
  VerifyPhoton
} = require("./BackendUtils");

const app = express();
const Title = "Stumble Land Back " + process.env.version;
const PORT = process.env.PORT || 8080;

// O jogo manda URLs com barra dupla (ex: //shared/0/NULL). Normaliza antes de qualquer rota.
app.use((req, res, next) => {
  if (req.url.includes('//')) req.url = req.url.replace(/\/{2,}/g, '/');
  next();
});

// Log de toda requisição (método, rota, status, tempo) e aviso se alguma ficar sem resposta
app.use((req, res, next) => {
  const t0 = Date.now();
  const stuck = setTimeout(() => Console.warn("HTTP", `SEM RESPOSTA há 10s: ${req.method} ${req.originalUrl}`), 10000);
  res.on("finish", () => {
    clearTimeout(stuck);
    Console.log("HTTP", `${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - t0}ms)`, res.statusCode >= 400 ? 31 : 32);
  });
  res.on("close", () => clearTimeout(stuck));
  next();
});

// Se o banco ainda não conectou, responde rápido com 503 e explica no log (em vez de dar erro interno)
app.use((req, res, next) => {
  if (!database.collections.Users) {
    Console.warn("Database", `Banco não conectado ainda — ${req.method} ${req.originalUrl} recusado (503)`);
    return res.status(503).json({ message: "Database not ready" });
  }
  next();
});

app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(authenticate);

app.post("/photon/auth", VerifyPhoton);
app.get("/onlinecheck", OnlineCheck);

const legacyAuthHandler = async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let headerJson = {};
    if (authHeader) {
      try {
        headerJson = JSON.parse(authHeader);
      } catch (_) {
        headerJson = {};
      }
    }

    const body = req.body || {};
    const normalizedBody = {
      DeviceId: body.DeviceId || body.deviceId || headerJson.DeviceId || req.user?.deviceId,
      StumbleId: body.StumbleId || body.stumbleId || headerJson.StumbleId,
      Version: body.Version || body.version || '0.56',
      newUsername: body.newUsername || body.username,
      hash: body.hash,
      country: body.country
    };

    if (normalizedBody.DeviceId) {
      req.body = normalizedBody;
      return UserController.login(req, res);
    }

    return res.status(200).json({ success: true, authorized: true, backend: 'stumbleland2', version: '0.56' });
  } catch (err) {
    Console.error('LegacyAuth', err);
    return res.status(200).json({ success: true, authorized: true, backend: 'stumbleland2', version: '0.56' });
  }
};
app.post('/auth', legacyAuthHandler);
app.post('/auth/', legacyAuthHandler);

app.get("/matchmaking/filter", MatchmakingController.getMatchmakingFilter);

app.post('/user/login', UserController.login);
app.post('/user/login/', UserController.login);
app.get('/user/config', sendShared);
app.get('/usersettings', UserController.getSettings);
app.post('/user/updateusername', UserController.updateUsername);
app.post('/user/changeusername', UserController.changeUsername);
app.get('/user/deleteaccount', UserController.deleteAccount);
app.post('/user/linkplatform', UserController.linkPlatform);
app.post('/user/unlinkplatform', UserController.unlinkPlatform);
app.get("/shared/:version/:type", sendShared);
app.post('/user/profile', UserController.getProfile);
app.post('/user-equipped-cosmetics/update', UserController.updateCosmetics);
app.post('/user/cosmetics/addskin', UserController.addSkin);
app.post('/user/cosmetics/setequipped', UserController.setEquippedCosmetic);
app.post('/friends/request/accept', FriendsController.add);
app.delete('/friends/:UserId', FriendsController.remove);
app.get('/friends', FriendsController.list);
app.post('/friends/search', FriendsController.search);
app.post('/friends/request', FriendsController.request);
app.post('/friends/accept', FriendsController.accept);
app.post('/friends/request/decline', FriendsController.reject);
app.post('/friends/cancel', FriendsController.cancel);
app.get('/friends/request', FriendsController.pending);
app.get('/social/interactions', SocialController.getInteractions);
app.get('//social/interactions', SocialController.getInteractions);
app.get('/round/finish/:round', RoundController.finishRound);
app.get('/round/finishv2/:round', RoundController.finishRound);
app.post('/round/finish/v4/:round', RoundController.finishRoundV4);
app.post('/round/eventfinish/v4/:round', RoundController.finishRoundV4);

app.get('/battlepass', BattlePassController.getBattlePass);
app.post('/battlepass/claimv3', BattlePassController.claimReward);
app.post('/battlepass/purchase', BattlePassController.purchaseBattlePass);
app.post('/battlepass/complete', BattlePassController.completeBattlePass);

app.get('/economy/purchase/:item', EconomyController.purchase); 

app.get('/economy/gasha/:itemId', EconomyController.getGashaInfo);
app.get('/economy/gasha', EconomyController.getGashaInfo);
app.get('/economy/drop/:itemId', EconomyController.getGashaInfo);
app.get('/economy/drop', EconomyController.getGashaInfo);
app.get('/economy/purchasedrop', EconomyController.purchaseGasha);
app.get('/economy/purchasegasha', EconomyController.purchaseGasha);
app.get('/economy/purchasegasha/:itemId/:count', EconomyController.purchaseGasha); 
app.get('/economy/purchasegasha/:itemId', EconomyController.purchaseGasha); 
app.get('/economy/purchasedrop/:itemId', EconomyController.purchaseGasha); 
app.get('/economy/purchaseluckyspin', EconomyController.purchaseLuckySpin); 
app.get('/economy/purchaseluckyspinwheel', (req, res) => { req.params.wheelType = req.params.wheelType || req.query.type || 'lucky'; return EconomyController.purchaseLuckySpin(req, res); }); 
app.get('/economy/purchaseluckyspinwheel/:wheelType', EconomyController.purchaseLuckySpin); 
app.get('/economy/luckyspinwheel', (req, res) => EconomyController.getLuckySpin(req, res));
app.get('/economy/luckyspinwheel/:wheelType', (req, res) => EconomyController.getLuckySpin(req, res));

app.get('/economy/purchaseluckyspin/:wheelType', EconomyController.purchaseLuckySpin); 
app.get('/economy/purchasewheel/:wheelType', EconomyController.purchaseLuckySpin); 
app.get('/economy/purchase/common', (req, res) => { req.params.wheelType = 'common'; return EconomyController.purchaseLuckySpin(req, res); }); 
app.get('/economy/purchase/rare', (req, res) => { req.params.wheelType = 'rare'; return EconomyController.purchaseLuckySpin(req, res); }); 
app.get('/economy/purchase/epic', (req, res) => { req.params.wheelType = 'epic'; return EconomyController.purchaseLuckySpin(req, res); }); 
app.get('/economy/purchase/lucky', (req, res) => { req.params.wheelType = 'lucky'; return EconomyController.purchaseLuckySpin(req, res); }); 
app.get('/economy/purchasedrop/:itemId/:count', EconomyController.purchaseGasha); 
app.post('/economy/:currencyType/give/:amount', EconomyController.giveCurrency); 

app.get('/missions', MissionsController.getMissions);
app.post('/missions/:missionId/rewards/claim/v2', MissionsController.claimMissionReward);
app.post('/missions/objective/:objectiveId/:milestoneId/rewards/claim/v2', MissionsController.claimMilestoneReward);

app.post('/friends/request/accept', FriendsController.add);
app.delete('/friends/:UserId', FriendsController.remove);
app.get('/friends', FriendsController.list);
app.post('/friends/search', FriendsController.search);
app.post('/friends/request', FriendsController.request);
app.post('/friends/accept', FriendsController.accept);
app.post('/friends/request/decline', FriendsController.reject);
app.post('/friends/cancel', FriendsController.cancel);
app.get('/friends/request', FriendsController.pending);

app.get("/game-events/me", EventsController.getActive);

app.get("/news/getall", NewsController.GetNews);

app.post('/analytics', AnalyticsController.analytic);

app.get('/highscore/:type/list/', async (req, res, next) => {
  try {
    const { type } = req.params;
    const { start = 0, count = 100, country = 'global' } = req.query;

    const startNum = parseInt(start, 10);
    const countNum = parseInt(count, 10);

    if (!type) {
      return res.status(400).json({ error: "Type is required" });
    }

    if (isNaN(startNum) || isNaN(countNum)) {
      return res.status(400).json({ error: "The start and count parameters must be numbers." });
    }

    const result = await UserModel.GetHighscore(type, country, startNum, countNum);

    res.json(result);
  } catch (err) {
    next(err);
  }
});

app.get("/social/interactions", SocialController.getInteractions);

app.get("/tournamentx/active", TournamentXController.getActive);
app.get("/tournamentx/active/v2", TournamentXController.getActive);
app.get("/tournamentx/seasons", TournamentXController.getSeasons);
app.get("/tournamentx/season/:seasonId/progress", TournamentXController.getSeasonProgress);
app.post("/tournamentx/season/:seasonId/claim/:awardId", TournamentXController.claimSeasonReward);
app.post("/tournamentx/:tournamentId/join", TournamentXController.join);
app.post("/tournamentx/:tournamentId/join/v2", TournamentXController.join);
app.post("/tournamentx/:tournamentId/leave", TournamentXController.leave);
app.post("/tournamentx/:tournamentId/leave/v2", TournamentXController.leave);
app.post("/round/tournament/finish/v2", TournamentXController.finish);

app.get("/api/v1/ping", async (req, res) => {
  res.status(200).send("OK");
});
app.post("/api/v1/userLoginExternal", TournamentController.login);
app.get("/api/v1/tournaments", TournamentController.getActive);

app.get('/round/finish/:round', RoundController.finishRound);
app.get('/round/finishv2/:round', RoundController.finishRound);
app.post('/round/finish/v4/:round?', RoundController.finishRoundV4);
app.post('/round/eventfinish/v4/:round?', RoundController.finishRoundV4);

// Handle the v3 route pattern that the client is calling
app.post('/round/finish/v3/:country/:gameId/:userId', (req, res) => {
  // Extract round from request body and add it to params for compatibility
  req.params.round = req.body.Round;
  RoundController.finishRoundV4(req, res);
});

app.get('/economy/luckyspin', (req, res) => EconomyController.getLuckySpin(req, res));
app.get('/economy/luckyspin/:wheelType', (req, res) => EconomyController.getLuckySpin(req, res));
app.get('/economy/wheel/:wheelType', (req, res) => EconomyController.getLuckySpin(req, res));
app.get('/economy/wheels', (req, res) => res.json({ success: true, wheels: ['common', 'rare', 'epic', 'lucky'] }));
app.get('/economy/wheel', (req, res) => EconomyController.getLuckySpin(req, res));
app.get('/economy/spin', (req, res) => EconomyController.getLuckySpin(req, res));
app.get('/economy/item/:itemId', EconomyController.getGashaInfo);
app.get('/economy/item', EconomyController.getGashaInfo);





// Handle custom round finish for custom parties
app.post('/round/customroundfinish/:country/:gameId/:userId', RoundController.finishCustomRound);
app.post('//round/customroundfinish/:country/:gameId/:userId', RoundController.finishCustomRound);

// ---- Roleta (POST) ----
// Roleta via POST: descobre o tipo da roleta e o tipo de giro a partir do corpo/query/rota
const WHEEL_KEYS = ['common', 'rare', 'epic', 'lucky'];
const wheelFromBody = (req, res) => {
  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const q = req.query || {};
  Console.log('Wheel', `${req.originalUrl} body=${JSON.stringify(b).slice(0, 400)} query=${JSON.stringify(q).slice(0, 200)}`);

  let wheelType = req.params.wheelType;
  if (!wheelType) {
    const values = [...Object.values(b), ...Object.values(q)].filter(v => typeof v === 'string').map(v => v.toLowerCase());
    wheelType = WHEEL_KEYS.find(k => values.some(v => v === k || v.includes(k))) || 'lucky';
  }
  req.params.wheelType = wheelType;
  req.spinType = b.spinType || b.SpinType || b.spin_type || q.spinType || null;
  return EconomyController.purchaseLuckySpin(req, res);
};
app.post('/economy/purchaseluckyspinwheel', wheelFromBody);
app.post('/economy/purchaseluckyspinwheel/:wheelType', wheelFromBody);
app.post('/economy/purchaseluckyspin', wheelFromBody);
app.post('/economy/purchaseluckyspin/:wheelType', wheelFromBody);

app.use(errorControll);

app.listen(PORT, () => {
  const currentDate = new Date().toLocaleString().replace(",", " |");
  console.clear();
  Console.log(
    "Server",
    `[${Title}] | ${currentDate} | ${CryptoUtils.SessionToken()}`
  );
  Console.log("Server", `Listening on port ${PORT}`);

  // Inicia o bot do Discord junto com o backend (antes o bot.js nunca era carregado)
  try {
    require("./bot");
  } catch (err) {
    Console.error("Bot", "Falha ao iniciar o bot: " + (err && err.message));
  }
});

// Evita que um erro solto derrube o servidor inteiro (Node 15+ encerra o processo por padrão)
process.on("unhandledRejection", (err) => Console.error("UnhandledRejection", String(err && err.stack || err)));
process.on("uncaughtException", (err) => Console.error("UncaughtException", String(err && err.stack || err)));