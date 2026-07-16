import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

export type Language = "en" | "zh-CN";
export type CountUnit = "memo" | "day" | "character" | "image" | "tag" | "item";

interface I18nContextValue {
  language: Language;
  locale: "en-US" | "zh-CN";
  setLanguage: (language: Language) => void;
  tr: (en: string, zh: string) => string;
  formatNumber: (value: number) => string;
  count: (value: number, unit: CountUnit) => string;
  errorMessage: (cause: unknown, fallbackEn?: string, fallbackZh?: string) => string;
}

const STORAGE_KEY = "memo:language";
const I18nContext = createContext<I18nContextValue | null>(null);

const ENGLISH_UNITS: Record<CountUnit, readonly [singular: string, plural: string]> = {
  memo: ["memo", "memos"],
  day: ["day", "days"],
  character: ["character", "characters"],
  image: ["image", "images"],
  tag: ["tag", "tags"],
  item: ["item", "items"]
};

const CHINESE_UNITS: Record<CountUnit, string> = {
  memo: "条笔记",
  day: "天",
  character: "字",
  image: "张图片",
  tag: "个标签",
  item: "项"
};

interface ErrorTranslation {
  en: string;
  zh: string;
}

const KNOWN_ERRORS: Record<string, ErrorTranslation> = {
  "Authentication required": { en: "Authentication required", zh: "需要重新登录" },
  "Invalid login": { en: "Incorrect passcode. Please try again.", zh: "密码错误，请重试" },
  "Wrong current passcode": { en: "The current passcode is incorrect. Please try again.", zh: "当前密码不正确，请重试" },
  "Passcode must be 4-18 digits": { en: "The passcode must contain 4 to 18 digits.", zh: "密码必须是 4-18 位数字" },
  "Passcode already configured": { en: "A passcode has already been configured.", zh: "访问密码已经设置" },
  "Invalid origin": { en: "This request came from an invalid origin.", zh: "请求来源无效" },
  "Invalid request body": { en: "The request data is invalid.", zh: "请求数据无效" },
  "Memo not found": { en: "Memo not found.", zh: "笔记不存在" },
  "Image not found": { en: "Image not found.", zh: "图片不存在" },
  "SESSION_SECRET is missing": { en: "The server is missing SESSION_SECRET.", zh: "服务器缺少 SESSION_SECRET 配置" },
  "Setup failed": { en: "Setup failed. Please try again.", zh: "设置失败，请重试" },
  "Change failed": { en: "The change failed. Please try again.", zh: "修改失败，请重试" },
  "Auth failed": { en: "Authentication failed. Please try again.", zh: "身份验证失败，请重试" },
  "无效的标签": { en: "Invalid tag.", zh: "无效的标签" },
  "无效的标签名": { en: "Invalid tag name.", zh: "无效的标签名" },
  "新旧名称相同": { en: "The new tag name is the same as the current name.", zh: "新旧名称相同" },
  "标签不存在": { en: "Tag not found.", zh: "标签不存在" },
  "内容不能为空": { en: "Content cannot be empty.", zh: "内容不能为空" },
  "笔记在回收站中，请先恢复": { en: "Restore this memo before editing it.", zh: "笔记在回收站中，请先恢复" },
  "无法读取图片": { en: "The image could not be read.", zh: "无法读取图片" },
  "无法处理图片": { en: "The image could not be processed.", zh: "无法处理图片" },
  "图片压缩后仍然过大": { en: "The image is still too large after compression.", zh: "图片压缩后仍然过大" },
  "Unable to read image": { en: "The image could not be read.", zh: "无法读取图片" },
  "Unable to process image": { en: "The image could not be processed.", zh: "无法处理图片" },
  "Image is still too large after compression": { en: "The image is still too large after compression.", zh: "图片压缩后仍然过大" },
  "图片过大": { en: "The image is too large.", zh: "图片过大" },
  "不支持的图片格式": { en: "This image format is not supported.", zh: "不支持的图片格式" }
};

function parseLanguage(value: string | null): Language {
  return value === "zh-CN" ? "zh-CN" : "en";
}

function loadLanguage(): Language {
  try {
    return parseLanguage(localStorage.getItem(STORAGE_KEY));
  } catch {
    return "en";
  }
}

function messageOf(cause: unknown): string | null {
  if (typeof cause === "string") return cause.trim() || null;
  if (cause instanceof Error) return cause.message.trim() || null;
  if (cause && typeof cause === "object" && "message" in cause && typeof cause.message === "string") {
    return cause.message.trim() || null;
  }
  return null;
}

function fieldOf(cause: unknown, field: string): unknown {
  return cause && typeof cause === "object" && field in cause ? (cause as Record<string, unknown>)[field] : undefined;
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguage] = useState<Language>(loadLanguage);
  const locale = language === "zh-CN" ? "zh-CN" : "en-US";

  useLayoutEffect(() => {
    document.documentElement.lang = language;
    try {
      localStorage.setItem(STORAGE_KEY, language);
    } catch {
      // Private browsing or disabled storage: retain the in-memory choice.
    }
  }, [language]);

  useEffect(() => {
    function onStorage(event: StorageEvent) {
      if (event.key !== STORAGE_KEY && event.key !== null) return;
      setLanguage(parseLanguage(event.key === null ? null : event.newValue));
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const tr = useCallback((en: string, zh: string) => (language === "zh-CN" ? zh : en), [language]);
  const numberFormatter = useMemo(() => new Intl.NumberFormat(locale), [locale]);
  const formatNumber = useCallback((value: number) => numberFormatter.format(value), [numberFormatter]);

  const count = useCallback(
    (value: number, unit: CountUnit) => {
      const number = numberFormatter.format(value);
      if (language === "zh-CN") return `${number} ${CHINESE_UNITS[unit]}`;
      const [singular, plural] = ENGLISH_UNITS[unit];
      return `${number} ${Math.abs(value) === 1 ? singular : plural}`;
    },
    [language, numberFormatter]
  );

  const errorMessage = useCallback(
    (cause: unknown, fallbackEn = "Something went wrong. Please try again.", fallbackZh = "操作失败，请重试") => {
      const codeValue = fieldOf(cause, "code");
      const code = typeof codeValue === "string" ? codeValue : null;
      const paramsValue = fieldOf(cause, "params");
      const params = paramsValue && typeof paramsValue === "object" && !Array.isArray(paramsValue) ? (paramsValue as Record<string, unknown>) : null;
      const localized = (en: string, zh: string) => (language === "zh-CN" ? zh : en);

      switch (code) {
        case "AUTH_REQUIRED":
          return localized("Your session has expired. Enter your passcode again.", "登录已过期，请重新输入密码");
        case "INVALID_LOGIN":
          return localized("Incorrect passcode. Please try again.", "密码错误，请重试");
        case "WRONG_CURRENT_PASSCODE":
          return localized("The current passcode is incorrect. Please try again.", "当前密码不正确，请重试");
        case "PASSCODE_INVALID":
          return localized("The passcode must contain 4 to 18 digits.", "密码必须是 4-18 位数字");
        case "PASSCODE_ALREADY_CONFIGURED":
          return localized("A passcode has already been configured.", "访问密码已经设置");
        case "INVALID_REQUEST_BODY":
          return localized("The request data is invalid.", "请求数据无效");
        case "MEMO_NOT_FOUND":
          return localized("Memo not found.", "笔记不存在");
        case "MEMO_ID_RETIRED":
          return localized(
            "That memo was permanently deleted. Your draft is safe; save again to create it with a new id.",
            "原笔记已被永久删除。草稿仍然保留；再次保存会使用新的编号创建。"
          );
        case "MEMO_TRASHED":
          return localized("Restore this memo before editing it.", "笔记在回收站中，请先恢复");
        case "MEMO_NOT_TRASHED":
          return localized("Move this memo to Trash before permanently deleting it.", "请先将笔记移入回收站，再彻底删除");
        case "VERSION_CONFLICT":
          return localized("This memo changed elsewhere. Review the latest version and try again.", "这条笔记已在别处更新，请确认最新版本后重试");
        case "DECRYPTION_FAILED":
          return localized(
            "The memos could not be decrypted. Check the server MEMO_ENC_KEY; no data will be written until it is fixed.",
            "无法解密笔记，请检查服务器 MEMO_ENC_KEY，修复前不会写入数据"
          );
        case "MEMO_EMPTY":
          return localized("A memo must contain text or at least one image.", "笔记需要包含文字或至少一张图片");
        case "MEMO_CONTENT_TOO_LONG": {
          const rawMax = params?.max;
          const max = typeof rawMax === "number" ? rawMax : typeof rawMax === "string" && rawMax.trim() ? Number(rawMax) : Number.NaN;
          if (!Number.isFinite(max)) return localized("This memo is too long.", "这条笔记内容过长");
          const formattedMax = numberFormatter.format(max);
          return localized(`A memo can contain up to ${formattedMax} characters.`, `每条笔记最多可包含 ${formattedMax} 个字符。`);
        }
        case "IMAGE_LIMIT_EXCEEDED": {
          const rawMax = params?.max;
          const max = typeof rawMax === "number" ? rawMax : typeof rawMax === "string" && rawMax.trim() ? Number(rawMax) : Number.NaN;
          if (!Number.isFinite(max)) return localized("This memo contains too many images.", "这条笔记包含的图片过多");
          const formattedMax = numberFormatter.format(max);
          return localized(
            `A memo can contain up to ${formattedMax} ${Math.abs(max) === 1 ? "image" : "images"}.`,
            `每条笔记最多可包含 ${formattedMax} 张图片。`
          );
        }
        case "IMAGE_TOO_LARGE":
          return localized("The image is too large.", "图片过大");
        case "IMAGE_TYPE_UNSUPPORTED":
          return localized("This image format is not supported.", "不支持的图片格式");
        case "BACKUP_MEMO_INVALID":
          return localized("The backup contains an invalid memo. Nothing from this chunk was imported.", "备份中包含无效笔记，本批次未导入任何内容");
        case "BACKUP_IMAGE_INVALID":
          return localized("The backup contains an invalid image attachment. Nothing from this chunk was imported.", "备份中包含无效图片，本批次未导入任何内容");
        case "TAG_INVALID":
          return localized("The tag name is invalid.", "无效的标签名");
        case "TAG_NAME_UNCHANGED":
          return localized("The new tag name is the same as the current name.", "新旧名称相同");
        case "TAG_NOT_FOUND":
          return localized("Tag not found.", "标签不存在");
        case "TAG_OPERATION_BUSY":
          return localized("Another tag rename or removal is still running. Try again shortly.", "另一个标签重命名或删除仍在进行，请稍后重试");
        case "IMAGE_NOT_FOUND":
          return localized("Image not found.", "图片不存在");
        case "INVALID_ORIGIN":
          return localized("This request came from an invalid origin.", "请求来源无效");
        case "INTERNAL_ERROR":
          return localized("The server could not complete the request. Please try again.", "服务器无法完成请求，请重试");
        case "REQUEST_FAILED": {
          const statusValue = fieldOf(cause, "status");
          return typeof statusValue === "number"
            ? localized(`Request failed (${statusValue})`, `请求失败 (${statusValue})`)
            : localized(fallbackEn, fallbackZh);
        }
      }

      const message = messageOf(cause);
      if (!message) return language === "zh-CN" ? fallbackZh : fallbackEn;

      const known = KNOWN_ERRORS[message];
      if (known) return language === "zh-CN" ? known.zh : known.en;

      const requestStatus = message.match(/^(?:请求失败|Request failed)\s*\((\d{3})\)$/i);
      if (requestStatus) {
        return language === "zh-CN" ? `请求失败 (${requestStatus[1]})` : `Request failed (${requestStatus[1]})`;
      }

      const imageLimit = message.match(/^最多\s*(\d+)\s*张图片$/);
      if (imageLimit) {
        return language === "zh-CN" ? `最多 ${imageLimit[1]} 张图片` : `A maximum of ${imageLimit[1]} images is allowed.`;
      }

      const containsChinese = /[\u3400-\u9fff]/u.test(message);
      if (language === "en" && containsChinese) return fallbackEn;
      if (language === "zh-CN" && !containsChinese) return fallbackZh;
      return message;
    },
    [language, numberFormatter]
  );

  const value = useMemo<I18nContextValue>(
    () => ({ language, locale, setLanguage, tr, formatNumber, count, errorMessage }),
    [language, locale, tr, formatNumber, count, errorMessage]
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  const context = useContext(I18nContext);
  if (!context) throw new Error("useI18n must be used inside <LanguageProvider>");
  return context;
}
