/** 产品名称与页面标题的唯一来源：改名只需要改这里（技术标识如命令行 tgdrive、环境变量 TGDRIVE_* 不属于品牌，保持不变）。 */
export const BRAND = "Tessera";
/** 品牌标语：侧栏、登录页、分享页与链接预览（og:title）共用；build-apps.mjs 从这里读取，不要改成模板字符串。 */
export const TAGLINE = "千片成璧，唯你可合";
/** 标语的展开说明：登录页与链接预览描述（og:description）。 */
export const STORY = "每个文件都被加密、切成碎片，散落在你自己的 Telegram 频道；只有你的钥匙，能把它们重新拼合完整。";
export const SITE = { user: BRAND, admin: `${BRAND} 控制台`, docs: `${BRAND} 文档` } as const;
