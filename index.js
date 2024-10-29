const express = require("express");
const axios = require("axios");
const cors = require("cors");
const puppeteer = require("puppeteer");
const { Storage } = require("@google-cloud/storage");
const { initializeApp, applicationDefault } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

const d1_id = "d4658898-a398-4788-9d0e-cdf755ce2cd9";
const cloudflare_account_id = process.env.CLOUDFLARE_ACCOUNT_ID;
const cloudflare_api_token = process.env.CLOUDFLARE_API_TOKEN;
const d1_endpoint = `https://api.cloudflare.com/client/v4/accounts/${cloudflare_account_id}/d1/database/${d1_id}/query`;
const bucketName = process.env.BUCKET_NAME;
const storage = new Storage();
const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

// Firebase Admin SDKの初期化
initializeApp({
  credential: applicationDefault(),
});

const allowedOrigins = [
  "http://localhost:8788",
  "https://artora.pages.dev",
  "https://develop.artora.pages.dev",
];

app.use(
  cors({
    origin: function (origin, callback) {
      // リクエストのoriginが許可リストに含まれているかを確認
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true); // 許可
      } else {
        callback(new Error("Not allowed by CORS")); // 拒否
      }
    },
  })
);

// JWTトークンの検証ミドルウェア
async function authenticateToken(req, res, next) {
  const authHeader = req.headers["authorization"];
  if (!authHeader) {
    return res.status(401).send("Authorization header missing");
  }

  const token = authHeader.split(" ")[1];
  try {
    const decodedToken = await getAuth().verifyIdToken(token);
    req.user = decodedToken;
    next(); // 認証成功時に次の処理に進む
  } catch (error) {
    console.error("Token verification failed:", error);
    return res.status(403).send("Unauthorized");
  }
}

// 画像取得は遅延実行にしたので、下記は実際は不要になる
// これを消す場合は、cloud monitoring の alert も削除すること
app.get("/", (res) => {
  res.send("Hello World!");
});

// firebase auth で認証されたユーザーを D1 に保存するエンドポイント
// uid を受け取る
// 匿名認証と google 認証の両方で使用する
app.post("/saveUser", authenticateToken, async (req, res) => {
  try {
    const uid = req.user.uid;
    const email = req.user.email || "";
    const displayName = req.user.displayName || "";
    const iconUrl = req.user.photoURL || "";
    const profileId = req.user.profileId || "";
    const createdAt = req.user.createdAt;

    const sql =
      "INSERT INTO users (uid, email, displayName, iconUrl, profileId, createdAt) VALUES (?, ?, ?, ?, ?, ?)";
    const params = [uid, email, displayName, iconUrl, profileId, createdAt];

    await prepare(sql, params);
    console.log("User saved successfully:", uid);
    res.status(200).send();
  } catch (error) {
    console.error("Failed to save user:", error);
    res.status(500).send();
  }
});

// pubsub は COMAJI のプロジェクト
// pubsub からの push を受け取るエンドポイント
app.post("/fetchDeck", async (req, res) => {
  try {
    const pubsubMessage = req.body.message;

    // Base64 デコードして、元のメッセージを取得
    const decodedData = Buffer.from(pubsubMessage.data, "base64").toString();
    const messageData = JSON.parse(decodedData);

    const { code, deckCodeId, apiToken } = messageData;

    if (apiToken !== process.env.API_TOKEN) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    if (!code || !deckCodeId) {
      return res
        .status(400)
        .send({ message: "Deck code and Deck ID are required" });
    }

    // メインの処理を実行
    const screenshotUrl = await accessPokemonCardSite(code);

    // prepare関数を使用してD1にクエリを実行
    const queryData = updateDeckCodeQuery(deckCodeId, screenshotUrl, code);
    const result = await prepare(queryData.sql, queryData.params);

    console.log("Cloudflare D1 query result:", result);

    res.status(200).send();
  } catch (error) {
    console.error("Failed to fetch deck:", error);
    res.status(500).send();
  }
});

const updateDeckCodeQuery = (deckCodeId, screenshotUrl, code) => {
  return {
    sql: "UPDATE deckCodes SET imageUrl = ?, code = ? WHERE Id = ?",
    params: [screenshotUrl, code, deckCodeId],
  };
};

const prepare = async (sql, params = []) => {
  try {
    const response = await axios.post(
      d1_endpoint,
      {
        sql: sql,
        params: params,
      },
      {
        headers: {
          Authorization: `Bearer ${cloudflare_api_token}`,
          "Content-Type": "application/json",
        },
      }
    );
    return response.data;
  } catch (error) {
    console.error(
      "Failed to execute query:",
      error.response ? error.response.data : error.message
    );
    throw error;
  }
};

// ローカル開発用のエンドポイント
// ローカルでの開発時には、fetchDeck の代わりにこちらを使用する
// puppeteer で画像を取得して、GCS にアップロードする
// 画像のURLを返す
app.post("/dev_fetchDeck", async (req, res) => {
  try {
    const { deckCode, apiToken } = req.body;

    if (apiToken !== process.env.API_TOKEN) {
      return res.status(401).send({ message: "Unauthorized" });
    }

    if (!deckCode) {
      return res.status(400).send({ message: "Deck code is required" });
    }

    // メインの処理を実行
    const screenshotUrl = await accessPokemonCardSite(deckCode);
    res.send({ message: "Deck fetched successfully", url: screenshotUrl });
  } catch (error) {
    console.error("Failed to fetch deck:", error);
    res.status(500).send({
      message: "Failed to fetch deck due to an error: " + error.message,
    });
  }
});

async function accessPokemonCardSite(deckCode) {
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      executablePath: "/usr/bin/google-chrome-stable",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    });

    const page = await browser.newPage();
    await page.goto("https://www.pokemon-card.com/deck/", {
      waitUntil: "networkidle2",
    });

    page.on("dialog", async (dialog) => {
      await dialog.accept();
    });

    console.log("Typing deck ID...");
    await page.type("#deckID", deckCode);
    await page.click("#searchDeckView");
    await page.waitForNavigation({
      waitUntil: "networkidle2",
    });

    console.log("Clicking regulation check button...");
    await page.click("#fr_regulationChekcBtn");
    await sleep(300);

    console.log("Registering deck data...");
    await page.click("#fr_registDeckData");
    await sleep(300);

    console.log("Waiting for image button to become visible...");
    await page.waitForSelector("#deckImgeBtn", { visible: true });

    console.log("Clicking image button...");
    await page.click("#deckImgeBtn");

    const newPage = await new Promise((resolve) =>
      browser.once("targetcreated", async (target) =>
        resolve(await target.page())
      )
    );
    console.log("New page opened for deck image...");
    await newPage
      .waitForSelector(".deckThumbsImg", { visible: true })
      .catch((e) => console.error("deckThumbsImg selector not found:", e));

    console.log("Taking screenshot...");
    const deckImageElement = await newPage.$(".deckThumbsImg");
    const buffer = await deckImageElement.screenshot();
    const screenshotPath = `screenshots/${deckCode}_final.png`;
    console.log("Screenshot taken successfully:", screenshotPath);

    console.log("Uploading screenshot to Google Cloud Storage...");
    const screenshotUrl = await uploadBufferToGCS(buffer, screenshotPath);

    await browser.close();
    console.log("Browser closed successfully.");
    return screenshotUrl;
  } catch (error) {
    if (browser) {
      console.error("Closing browser due to an error...");
      await browser.close();
    }
    throw new Error(
      "An error occurred while accessing the site: " + error.message
    );
  }
}

async function uploadBufferToGCS(buffer, destFileName) {
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(destFileName);
  const stream = file.createWriteStream({
    metadata: {
      contentType: "image/png",
    },
  });

  return new Promise((resolve, reject) => {
    stream.on("error", (err) => {
      console.error("Stream to GCS had an error", err);
      reject(err);
    });

    stream.on("finish", () => {
      console.log(
        `The file was uploaded successfully to ${bucketName}/${destFileName}`
      );
      resolve(`https://storage.googleapis.com/${bucketName}/${destFileName}`);
    });

    stream.end(buffer);
  });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
