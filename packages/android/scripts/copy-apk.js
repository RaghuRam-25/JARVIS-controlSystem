import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const sourceDir = path.join(__dirname, "../app/build/outputs/apk/debug");
const targetDir = path.join(__dirname, "../../../dist/android");

if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

const sourceFile = path.join(sourceDir, "JARVIS.apk");
const targetFile = path.join(targetDir, "JARVIS.apk");

if (fs.existsSync(sourceFile)) {
  fs.copyFileSync(sourceFile, targetFile);
  console.log("=================================================");
  console.log("  JARVIS ANDROID APK GENERATED SUCCESSFULLY!     ");
  console.log("=================================================");
  console.log(`  Source : ${sourceFile}`);
  console.log(`  Target : ${targetFile}`);
  console.log("=================================================");
} else {
  // Check for app-debug.apk fallback
  const altSource = path.join(sourceDir, "app-debug.apk");
  if (fs.existsSync(altSource)) {
    fs.copyFileSync(altSource, targetFile);
    console.log(`Copied ${altSource} -> ${targetFile}`);
  } else {
    console.log(`APK build outputs located in: ${sourceDir}`);
  }
}
