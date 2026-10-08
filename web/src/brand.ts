/** 产品名称与页面标题的唯一来源：改名只需要改这里（技术标识如命令行 tgdrive、环境变量 TGDRIVE_* 不属于品牌，保持不变）。 */
export const BRAND = "Tessera";
export const TAGLINE = "加密分片的私人云盘";
export const SITE = { user: BRAND, admin: `${BRAND} 控制台`, docs: `${BRAND} 文档` } as const;
