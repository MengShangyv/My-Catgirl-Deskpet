#!/usr/bin/env node
/**
 * gen-assets.mjs — 为猫娘桌宠生成 Q版猫娘 PNG 素材（idle/working/done/error/tray）。
 *
 * 用法:
 *   node scripts/gen-assets.mjs            # 已存在且有效的图片会跳过
 *   node scripts/gen-assets.mjs --force    # 删除旧图后重新生成
 *
 * 环境变量（均可选）:
 *   IMAGE_API_KEY      直连图片 API 的 key（默认从 cc-switch.db 里找 xfxai 供应商的 key）
 *   IMAGE_API_BASE_URL 默认 https://new.xfxai.top/v1
 *   IMAGE_API_MODEL    默认 gpt-image-2
 *   CC_SWITCH_DB       cc-switch 数据库路径，默认 ~/.cc-switch/cc-switch.db
 *
 * 说明：本机 cc-switch 本地代理 (127.0.0.1:15721) 当前供应商不支持
 * gpt-image-2（/responses 返回 model_not_found，/images/generations 直接 404），
 * 因此绕过代理直连供应商 OpenAI 兼容端点 /v1/images/generations。
 * 历史成功记录见 cc-switch.db proxy_request_logs（provider d4b21d7a / xfxai）。
 */

import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(SCRIPT_DIR, "..");
const OUT_DIR = join(PROJECT_ROOT, "assets", "cats");

const BASE_URL = (process.env.IMAGE_API_BASE_URL || "https://new.xfxai.top/v1").replace(/\/+$/, "");
const MODEL = process.env.IMAGE_API_MODEL || "gpt-image-2";
const CC_SWITCH_DB = process.env.CC_SWITCH_DB || join(homedir(), ".cc-switch", "cc-switch.db");

const REQUEST_TIMEOUT_MS = 180_000; // 单次生成请求预算
const DOWNLOAD_TIMEOUT_MS = 60_000; // 下载返回的图片 URL
const RETRY_BACKOFF_MS = 3_000; // 失败重试前的等待
const START_STAGGER_MS = 600; // 并发启动错峰，避免限流
const MIN_BYTES = 20 * 1024; // 每张图最小字节数

const FORCE = process.argv.includes("--force");

// ---------------------------------------------------------------------------
// 素材定义（基础描述完全一致，只变姿势表情，保证画风统一）
// ---------------------------------------------------------------------------

const BASE_PROMPT =
  "Cute chibi catgirl desktop pet mascot, white hair with cat ears (pink inner ears), " +
  "big round anime eyes, wearing a pastel pink hoodie, flat kawaii anime sticker style, " +
  "clean bold outlines, soft pastel colors, full body, front 3/4 view, centered composition, " +
  "transparent background";

const ASSETS = [
  {
    name: "idle.png",
    size: "1024x1024",
    sizeLadder: ["1024x1024"],
    prompt: `${BASE_PROMPT}, dozing off while sitting, eyes closed as gentle curves, head tilted, tiny "Zzz" floating above`,
  },
  {
    name: "working.png",
    size: "1024x1024",
    sizeLadder: ["1024x1024"],
    prompt: `${BASE_PROMPT}, sitting at a tiny laptop with glowing green terminal screen, focused determined expression, paws typing on keyboard`,
  },
  {
    name: "done.png",
    size: "1024x1024",
    sizeLadder: ["1024x1024"],
    prompt: `${BASE_PROMPT}, cheering with both paws raised up, big open-mouth smile, happy closed eyes, sparkles around`,
  },
  {
    name: "error.png",
    size: "1024x1024",
    sizeLadder: ["1024x1024"],
    prompt: `${BASE_PROMPT}, panicking with paws on cheeks, wide worried eyes, a big sweat drop, small red warning mark nearby`,
  },
  {
    name: "tray.png",
    size: "256x256",
    // gpt-image-2 可能不支持 256x256，逐级回退到支持的最小尺寸
    sizeLadder: ["256x256", "512x512", "1024x1024"],
    prompt:
      "Simple cute cat head icon, white cat face with pink inner ears, gentle smile, " +
      "flat kawaii sticker style, centered, transparent background",
  },
];

// ---------------------------------------------------------------------------
// API key 加载
// ---------------------------------------------------------------------------

async function loadApiKey() {
  if (process.env.IMAGE_API_KEY) return process.env.IMAGE_API_KEY;

  let db;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(CC_SWITCH_DB, { readOnly: true });
  } catch (err) {
    throw new Error(
      `无法打开 cc-switch 数据库 (${CC_SWITCH_DB}): ${err.message}。请设置 IMAGE_API_KEY 环境变量。`,
    );
  }

  try {
    const rows = db
      .prepare("SELECT app_type, settings_config FROM providers")
      .all()
      .map((r) => {
        let cfg = null;
        try {
          cfg = JSON.parse(r.settings_config);
        } catch {
          /* ignore malformed rows */
        }
        return { appType: r.app_type, cfg };
      })
      .filter((r) => r.cfg);

    const hasXfxai = (r) => /new\.xfxai\.top/i.test(JSON.stringify(r.cfg));

    // 优先：codex 供应商里指向 xfxai 的 OPENAI_API_KEY（历史成功记录所用）
    const codex = rows.find((r) => r.appType === "codex" && hasXfxai(r) && r.cfg?.auth?.OPENAI_API_KEY);
    if (codex) return codex.cfg.auth.OPENAI_API_KEY;

    // 其次：任意指向 xfxai 的供应商 token
    const any = rows.find((r) => hasXfxai(r) && (r.cfg?.auth?.OPENAI_API_KEY || r.cfg?.env?.ANTHROPIC_AUTH_TOKEN));
    if (any) return any.cfg.auth?.OPENAI_API_KEY || any.cfg.env.ANTHROPIC_AUTH_TOKEN;

    throw new Error(
      "cc-switch.db 中没有找到 xfxai 供应商的 API key。请设置 IMAGE_API_KEY 环境变量。",
    );
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// HTTP / 图片请求
// ---------------------------------------------------------------------------

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyApiError(status, bodyText) {
  if (status === 400 && /invalid_size|size is invalid|unsupported size/i.test(bodyText)) return "invalid_size";
  if (status === 400 && /(background|output_format|unknown parameter|unrecognized|invalid parameter)/i.test(bodyText))
    return "param";
  return "other";
}

async function requestImageBytes(prompt, size, useOptionalParams, apiKey) {
  const body = { model: MODEL, prompt, size };
  if (useOptionalParams) {
    body.background = "transparent";
    body.output_format = "png";
  }

  const res = await fetchWithTimeout(
    `${BASE_URL}/images/generations`,
    {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    },
    REQUEST_TIMEOUT_MS,
  );

  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    err.kind = classifyApiError(res.status, text);
    throw err;
  }

  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`响应不是合法 JSON: ${text.slice(0, 200)}`);
  }

  const item = json?.data?.[0];
  let b64 = item?.b64_json;
  if (typeof b64 === "string" && b64.startsWith("data:image/")) {
    b64 = b64.slice(b64.indexOf(",") + 1);
  }

  if (b64) {
    const bytes = Buffer.from(b64, "base64");
    if (!bytes.length) throw new Error("b64_json 解码后为空");
    return bytes;
  }

  if (item?.url) {
    const dl = await fetchWithTimeout(item.url, { headers: { accept: "image/*" } }, DOWNLOAD_TIMEOUT_MS);
    if (!dl.ok) throw new Error(`下载图片失败 HTTP ${dl.status}`);
    const contentType = (dl.headers.get("content-type") || "").toLowerCase();
    if (contentType && !contentType.startsWith("image/")) {
      throw new Error(`图片 URL 返回了非图片内容类型: ${contentType}`);
    }
    const bytes = Buffer.from(await dl.arrayBuffer());
    if (!bytes.length) throw new Error("下载的图片为空");
    return bytes;
  }

  throw new Error(`响应中没有 b64_json 或 url: ${JSON.stringify(json).slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// PNG 校验
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function parsePngHeader(bytes) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("不是合法的 PNG 文件（签名不匹配）");
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

async function isValidExistingPng(filePath) {
  try {
    const st = await stat(filePath);
    if (st.size <= MIN_BYTES) return false;
    const fh = await open(filePath, "r");
    try {
      const head = Buffer.alloc(24);
      const { bytesRead } = await fh.read(head, 0, 24, 0);
      if (bytesRead < 24) return false;
      parsePngHeader(head);
      return true;
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 单个素材的生成流程：尝试计划 + 失败重试 1 次 + 临时文件落盘
// ---------------------------------------------------------------------------

function buildPlans(asset) {
  const plans = [];
  for (const size of asset.sizeLadder) plans.push({ size, optionalParams: true });
  for (const size of asset.sizeLadder) plans.push({ size, optionalParams: false });
  return plans;
}

async function generateAsset(asset, apiKey) {
  const finalPath = join(OUT_DIR, asset.name);

  if (!FORCE && (await isValidExistingPng(finalPath))) {
    const st = await stat(finalPath);
    return { name: asset.name, path: finalPath, status: "skipped", bytes: st.size };
  }
  if (FORCE) await rm(finalPath, { force: true });

  const plans = buildPlans(asset);
  const failures = [];
  let lastError = null;

  // 2 轮 = 首次 + 失败重试 1 次
  for (let round = 1; round <= 2; round++) {
    for (const plan of plans) {
      const t0 = Date.now();
      try {
        process.stdout.write(`[${asset.name}] 第${round}轮尝试 size=${plan.size}${plan.optionalParams ? "" : " (无可选参数)"} ... `);
        const bytes = await requestImageBytes(asset.prompt, plan.size, plan.optionalParams, apiKey);
        parsePngHeader(bytes); // 必须是 PNG
        if (bytes.length <= MIN_BYTES) {
          throw new Error(`图片太小 (${bytes.length} bytes <= ${MIN_BYTES})`);
        }

        // 临时文件写入 → 校验 → rename 到最终名（避免覆盖问题/半写文件）
        const tempPath = join(OUT_DIR, `${asset.name}.tmp-${randomUUID()}`);
        try {
          await writeFile(tempPath, bytes, { flag: "wx" });
          await rename(tempPath, finalPath);
        } catch (err) {
          await unlink(tempPath).catch(() => {});
          throw err;
        }

        const { width, height } = parsePngHeader(bytes);
        console.log(
          `成功 (${((Date.now() - t0) / 1000).toFixed(1)}s, ${width}x${height}, ${(bytes.length / 1024).toFixed(1)} KB)`,
        );
        return {
          name: asset.name,
          path: finalPath,
          status: "generated",
          bytes: bytes.length,
          width,
          height,
          size: plan.size,
          retries: round - 1,
        };
      } catch (err) {
        lastError = err;
        const took = ((Date.now() - t0) / 1000).toFixed(1);
        const brief = err.kind ? `[${err.kind}] ` : "";
        console.log(`失败 (${took}s) ${brief}${err.message.split("\n")[0].slice(0, 160)}`);
        if (err.kind === "invalid_size" || err.kind === "param") {
          continue; // 换下一个计划（更小的可选尺寸 / 去掉可选参数），不算重试
        }
        failures.push(err.message);
        break; // 真失败 → 进入下一轮（重试）
      }
    }
    if (round === 1 && lastError) {
      console.log(`[${asset.name}] ${RETRY_BACKOFF_MS / 1000}s 后重试...`);
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS));
    }
  }

  throw new Error(`所有尝试均失败: ${lastError?.message || failures.join(" | ")}`);
}

// ---------------------------------------------------------------------------
// 主流程：并发执行（Promise.allSettled），错峰启动
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const apiKey = await loadApiKey();
  console.log(`图片 API: ${BASE_URL}  模型: ${MODEL}  key: ${apiKey.slice(0, 6)}***`);
  console.log(`输出目录: ${OUT_DIR}${FORCE ? "  (--force，重新生成)" : ""}`);
  await mkdir(OUT_DIR, { recursive: true });

  const t0 = Date.now();
  const results = await Promise.allSettled(
    ASSETS.map(async (asset, index) => {
      await sleep(index * START_STAGGER_MS);
      return generateAsset(asset, apiKey);
    }),
  );

  console.log("\n========== 结果汇总 ==========");
  let ok = 0;
  for (let i = 0; i < ASSETS.length; i++) {
    const r = results[i];
    const name = ASSETS[i].name;
    if (r.status === "fulfilled") {
      ok++;
      const d = r.value;
      const dim = d.width ? ` ${d.width}x${d.height}` : "";
      const extra = d.status === "generated" ? ` (size=${d.size}${d.retries ? `, 重试${d.retries}次` : ""})` : "";
      console.log(`  OK    ${name}${dim}  ${(d.bytes / 1024).toFixed(1)} KB${extra}`);
      console.log(`        ${d.path}`);
    } else {
      console.log(`  FAIL  ${name}: ${r.reason?.message?.slice(0, 200)}`);
    }
  }
  console.log(`耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s，成功 ${ok}/${ASSETS.length}`);
  process.exitCode = ok === ASSETS.length ? 0 : 1;
}

main().catch((err) => {
  console.error(`致命错误: ${err.message}`);
  process.exitCode = 1;
});
