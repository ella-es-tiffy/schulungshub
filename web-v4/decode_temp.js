const fs = require("fs");
const path = require("path");

const dataJsPath = path.join(__dirname, "data.js");
const src = fs.readFileSync(dataJsPath, "utf8");
const match = src.match(/window\._ED\s*=\s*"([^"]+)"/);

if (match) {
  const key = "SchulungsHub-Siebdruck-2026";
  const raw = Buffer.from(match[1], "base64");
  const keyBytes = Buffer.from(key);
  for (let i = 0; i < raw.length; i++) raw[i] = raw[i] ^ keyBytes[i % keyBytes.length];
  const data = JSON.parse(raw.toString("utf8"));
  console.log(JSON.stringify(data, null, 2));
} else {
    console.error("No encoded data found.");
}
