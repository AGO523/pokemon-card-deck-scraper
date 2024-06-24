const express = require("express");
const bodyParser = require("body-parser");
const puppeteer = require("puppeteer");
const { Storage } = require("@google-cloud/storage");
const healthz = require("./healthz");

const bucketName = process.env.BUCKET_NAME;
const storage = new Storage();
const app = express();
const port = process.env.PORT || 8080;

app.use(express.json());

app.get("/healthz", healthz);

app.post("/fetchDeck", async (req, res) => {
  const { deckCode } = req.body;
  if (!deckCode) {
    return res.status(400).send({ message: "Deck code is required" });
  }

  try {
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
