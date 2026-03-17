const STORAGE_KEY = "ingredient_translation_tables_v2";

const tableFile = document.getElementById("tableFile");
const uploadBtn = document.getElementById("uploadBtn");
const uploadStatus = document.getElementById("uploadStatus");
const versionSelect = document.getElementById("versionSelect");
const langSelect = document.getElementById("langSelect");
const inputText = document.getElementById("inputText");
const translateBtn = document.getElementById("translateBtn");
const outputText = document.getElementById("outputText");

function loadVersions() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveVersions(versions) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(versions));
}

function normalizeText(text) {
  return String(text ?? "")
    .replace(/\u00A0/g, " ")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function splitInput(text) {
  return text
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getLatestVersion(versions) {
  if (!versions.length) return null;
  return versions
    .slice()
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

function parseDelimitedLine(line, delimiter) {
  const cells = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === delimiter && !inQuotes) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function parseDelimited(content, delimiter) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) throw new Error("檔案內容為空");

  const headers = parseDelimitedLine(lines[0], delimiter);
  if (headers.length < 2) {
    throw new Error("對照表至少需要兩欄（例如：中文翻譯、英文名稱）");
  }

  const rows = lines.slice(1).map((line) => {
    const values = parseDelimitedLine(line, delimiter);
    const row = {};
    headers.forEach((header, index) => {
      row[header] = values[index] ?? "";
    });
    return row;
  });

  return { headers, rows };
}


function parseXml(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}

function getCellText(cell, sharedStrings) {
  const cellType = cell.getAttribute("t");

  if (cellType === "s") {
    const v = cell.querySelector("v")?.textContent || "";
    const idx = Number(v);
    return Number.isInteger(idx) ? sharedStrings[idx] || "" : "";
  }

  if (cellType === "inlineStr") {
    return cell.querySelector("is t")?.textContent || "";
  }

  return cell.querySelector("v")?.textContent || "";
}

function parseCellRef(ref) {
  const letters = (ref.match(/^[A-Z]+/i) || [""])[0].toUpperCase();
  let col = 0;

  for (const ch of letters) {
    col = col * 26 + (ch.charCodeAt(0) - 64);
  }

  return Math.max(0, col - 1);
}

function parseWorksheetXml(sheetText, sharedStrings) {
  const sheetDoc = parseXml(sheetText);
  const rows = [];

  sheetDoc.querySelectorAll("sheetData > row").forEach((rowNode) => {
    const row = {};

    rowNode.querySelectorAll("c").forEach((cell) => {
      const ref = cell.getAttribute("r") || "";
      const colIdx = parseCellRef(ref);
      row[colIdx] = getCellText(cell, sharedStrings).trim();
    });

    if (Object.keys(row).length) rows.push(row);
  });

  if (!rows.length) {
    throw new Error("XLSX 工作表內容為空");
  }

  const headerMap = rows[0];
  const sortedKeys = Object.keys(headerMap).map(Number).sort((a, b) => a - b);
  const headers = sortedKeys.map((idx) => headerMap[idx]).filter(Boolean);

  if (headers.length < 2) {
    throw new Error("XLSX 至少需要兩個欄位");
  }

  const dataRows = rows.slice(1).map((raw) => {
    const mapped = {};
    sortedKeys.forEach((idx) => {
      const header = headerMap[idx];
      if (!header) return;
      mapped[header] = raw[idx] || "";
    });
    return mapped;
  }).filter((row) => Object.values(row).some((v) => String(v).trim()));

  return { headers, rows: dataRows };
}

function readUInt16(view, offset) {
  return view.getUint16(offset, true);
}

function readUInt32(view, offset) {
  return view.getUint32(offset, true);
}

function findEocd(view) {
  for (let i = view.byteLength - 22; i >= Math.max(0, view.byteLength - 65557); i -= 1) {
    if (readUInt32(view, i) === 0x06054b50) return i;
  }
  throw new Error("XLSX 檔案格式錯誤（找不到 ZIP 結尾）");
}

async function inflateDeflateRaw(bytes) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("此瀏覽器不支援離線 XLSX 解析，請改用 server.py");
  }

  const ds = new DecompressionStream("deflate-raw");
  const decompressedStream = new Blob([bytes]).stream().pipeThrough(ds);
  const outBuffer = await new Response(decompressedStream).arrayBuffer();
  return new Uint8Array(outBuffer);
}

async function unzipEntries(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const decoder = new TextDecoder("utf-8");
  const eocdOffset = findEocd(view);
  const totalEntries = readUInt16(view, eocdOffset + 10);
  const centralDirOffset = readUInt32(view, eocdOffset + 16);

  const entries = new Map();
  let ptr = centralDirOffset;

  for (let i = 0; i < totalEntries; i += 1) {
    if (readUInt32(view, ptr) !== 0x02014b50) {
      throw new Error("XLSX 檔案格式錯誤（中央目錄）");
    }

    const compression = readUInt16(view, ptr + 10);
    const compressedSize = readUInt32(view, ptr + 20);
    const fileNameLen = readUInt16(view, ptr + 28);
    const extraLen = readUInt16(view, ptr + 30);
    const commentLen = readUInt16(view, ptr + 32);
    const localHeaderOffset = readUInt32(view, ptr + 42);

    const fileNameBytes = new Uint8Array(arrayBuffer, ptr + 46, fileNameLen);
    const fileName = decoder.decode(fileNameBytes);

    const localSig = readUInt32(view, localHeaderOffset);
    if (localSig !== 0x04034b50) {
      throw new Error("XLSX 檔案格式錯誤（本地檔頭）");
    }

    const localNameLen = readUInt16(view, localHeaderOffset + 26);
    const localExtraLen = readUInt16(view, localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressedBytes = new Uint8Array(arrayBuffer.slice(dataStart, dataStart + compressedSize));

    let plainBytes;
    if (compression === 0) {
      plainBytes = compressedBytes;
    } else if (compression === 8) {
      plainBytes = await inflateDeflateRaw(compressedBytes);
    } else {
      throw new Error(`XLSX 壓縮格式不支援（method=${compression}）`);
    }

    entries.set(fileName, decoder.decode(plainBytes));

    ptr += 46 + fileNameLen + extraLen + commentLen;
  }

  return entries;
}

function parseSharedStringsXml(xmlText) {
  if (!xmlText) return [];
  const doc = parseXml(xmlText);
  return Array.from(doc.querySelectorAll("si")).map((si) =>
    Array.from(si.querySelectorAll("t")).map((t) => t.textContent || "").join("")
  );
}

async function parseXLSXInBrowser(arrayBuffer) {
  const zipEntries = await unzipEntries(arrayBuffer);
  const sheetName = Array.from(zipEntries.keys()).find((name) =>
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
  );

  if (!sheetName) {
    throw new Error("XLSX 檔案沒有可用工作表");
  }

  const sharedStrings = parseSharedStringsXml(zipEntries.get("xl/sharedStrings.xml") || "");
  return parseWorksheetXml(zipEntries.get(sheetName), sharedStrings);
}

function buildApiCandidates() {
  const candidates = ["/api/parse-xlsx", "api/parse-xlsx"];
  const parts = window.location.pathname.split("/").filter(Boolean);

  for (let i = parts.length; i >= 1; i -= 1) {
    const prefix = `/${parts.slice(0, i).join("/")}`;
    candidates.push(`${prefix}/api/parse-xlsx`);
  }

  return [...new Set(candidates)];
}

async function parseXLSX(file) {
  const buffer = await file.arrayBuffer();

  try {
    return await parseXLSXInBrowser(buffer);
  } catch (browserError) {
    const formData = new FormData();
    formData.append("file", file, file.name);

    const endpoints = buildApiCandidates();
    const errors = [`browser: ${browserError.message}`];

    for (const endpoint of endpoints) {
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          body: formData
        });

        const contentType = response.headers.get("content-type") || "";
        const rawText = await response.text();

        if (!contentType.includes("application/json")) {
          errors.push(`${endpoint}: non-json response`);
          continue;
        }

        let payload;
        try {
          payload = JSON.parse(rawText);
        } catch {
          errors.push(`${endpoint}: invalid json`);
          continue;
        }

        if (!response.ok) {
          throw new Error(payload.error || "XLSX 解析失敗");
        }

        return payload;
      } catch (error) {
        errors.push(`${endpoint}: ${error.message}`);
      }
    }

    throw new Error(`XLSX 解析失敗（${errors.join("; ")}）`);
  }
}

function parseJSON(content) {
  const data = JSON.parse(content);
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("JSON 格式需為非空陣列");
  }

  const headers = Object.keys(data[0]);
  if (headers.length < 2) {
    throw new Error("JSON 至少需要兩個欄位");
  }

  return { headers, rows: data };
}

function detectDelimiter(content, fileName) {
  const firstLine = content.split(/\r?\n/).find((line) => line.trim()) ?? "";
  const lowerName = fileName.toLowerCase();

  if (lowerName.endsWith(".tsv") || firstLine.includes("\t")) return "\t";
  return ",";
}

function refreshVersionOptions() {
  const versions = loadVersions().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  versionSelect.innerHTML = "";

  if (!versions.length) {
    const option = document.createElement("option");
    option.textContent = "尚未上傳對照表";
    option.value = "";
    versionSelect.appendChild(option);
    refreshLanguageOptions();
    return;
  }

  versions.forEach((version, idx) => {
    const option = document.createElement("option");
    option.value = version.id;
    option.textContent = `${idx === 0 ? "最新版" : "舊版"}｜${new Date(version.createdAt).toLocaleString()}｜${version.fileName}`;
    versionSelect.appendChild(option);
  });

  refreshLanguageOptions();
}

function getSelectedVersion() {
  const versions = loadVersions();
  const selected = versions.find((v) => v.id === versionSelect.value);
  if (selected) return selected;
  return getLatestVersion(versions);
}

function refreshLanguageOptions() {
  const selectedVersion = getSelectedVersion();
  langSelect.innerHTML = "";

  if (!selectedVersion) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "請先上傳對照表";
    langSelect.appendChild(option);
    return;
  }

  selectedVersion.headers.forEach((header) => {
    const option = document.createElement("option");
    option.value = header;
    option.textContent = header;
    langSelect.appendChild(option);
  });
}

async function handleUpload() {
  const file = tableFile.files?.[0];
  if (!file) {
    uploadStatus.textContent = "請先選擇檔案。";
    return;
  }

  try {
    const lowerName = file.name.toLowerCase();
    let parsed;

    if (lowerName.endsWith(".json")) {
      const content = await file.text();
      parsed = parseJSON(content);
    } else if (lowerName.endsWith(".xlsx") || lowerName.endsWith(".xls")) {
      parsed = await parseXLSX(file);
    } else {
      const content = await file.text();
      const delimiter = detectDelimiter(content, file.name);
      parsed = parseDelimited(content, delimiter);
    }

    const newVersion = {
      id: crypto.randomUUID(),
      fileName: file.name,
      createdAt: new Date().toISOString(),
      headers: parsed.headers,
      rows: parsed.rows
    };

    const versions = loadVersions();
    versions.push(newVersion);
    saveVersions(versions);

    uploadStatus.textContent = `上傳成功：${file.name}（共 ${parsed.rows.length} 筆）`;
    refreshVersionOptions();
    versionSelect.value = newVersion.id;
    refreshLanguageOptions();
  } catch (error) {
    const message = String(error?.message || "未知錯誤");
    if (message.includes("Unexpected token '<'") || message.includes("non-json response")) {
      uploadStatus.textContent = "上傳失敗：XLSX 解析服務回應非 JSON。請改用 `python3 server.py` 或確認代理有轉發 `/api/parse-xlsx`。";
      return;
    }
    uploadStatus.textContent = `上傳失敗：${message}`;
  }
}

function findRowByAnyColumn(rows, input) {
  const normalizedInput = normalizeText(input);

  return rows.find((row) =>
    Object.values(row).some((value) => normalizeText(value) === normalizedInput)
  );
}

function handleTranslate() {
  const selectedVersion = getSelectedVersion();
  const targetLanguage = langSelect.value;

  if (!selectedVersion) {
    outputText.textContent = "尚未有可用的翻譯對照表。";
    return;
  }

  if (!targetLanguage) {
    outputText.textContent = "請先選擇目標語言。";
    return;
  }

  const items = splitInput(inputText.value);
  if (!items.length) {
    outputText.textContent = "請先輸入要翻譯的內容。";
    return;
  }

  const translated = items.map((item) => {
    const row = findRowByAnyColumn(selectedVersion.rows, item);
    const target = row?.[targetLanguage];

    if (!target) {
      return `${item} => （未找到翻譯）`;
    }

    return `${item} => ${target}`;
  });

  outputText.textContent = translated.join("\n");
}

uploadBtn.addEventListener("click", handleUpload);
versionSelect.addEventListener("change", refreshLanguageOptions);
translateBtn.addEventListener("click", handleTranslate);

refreshVersionOptions();
