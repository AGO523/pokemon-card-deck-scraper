const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const fs = require("fs");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// スクリーンショット用ディレクトリの確認・作成
const screenshotsDir = "./screenshots";
if (!fs.existsSync(screenshotsDir)) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
}

const app = express();
const port = 3000;

app.use(bodyParser.json());

app.post("/fetchDeck", async (req, res) => {
  const { deckCode } = req.body;
  if (!deckCode) {
    return res.status(400).send({ message: "Deck code is required" });
  }

  try {
    const result = await accessPokemonCardSite(deckCode);
    res.send({ message: "Deck fetched successfully", data: result });
  } catch (error) {
    console.error("Failed to fetch deck:", error);
    res.status(500).send({ message: "Failed to fetch deck" });
  }
});

async function accessPokemonCardSite(deckCode) {
  const browser = await puppeteer.launch({
    headless: false, // デバッグ時は false に設定
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.goto("https://www.pokemon-card.com/deck/", {
    waitUntil: "networkidle2",
  });

  page.on("dialog", async (dialog) => {
    await dialog.accept();
  });

  await page.type("#deckID", deckCode);
  await page.click("#searchDeckView");
  await page.waitForNavigation({ waitUntil: "networkidle2" });

  // レギュレーションチェックを押下
  await page.click("#fr_regulationChekcBtn");
  await sleep(2000);

  // デッキ登録を押下
  await page.click("#fr_registDeckData");
  await sleep(2000);

  // デッキ画像を押下
  await page.waitForSelector("#deckImgeBtn", { visible: true });
  await page.click("#deckImgeBtn");

  // 新しいタブが開かれるまで待機
  const newPagePromise = new Promise((x) =>
    browser.once("targetcreated", (target) => x(target.page()))
  );
  const newPage = await newPagePromise;
  await newPage.waitForSelector(".PopupMain", { visible: true });

  // デッキ画像を保存
  const screenshotPath = `screenshots/${deckCode}_final.png`;
  await newPage.screenshot({ path: screenshotPath });

  await browser.close();
  return screenshotPath;
}

app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
