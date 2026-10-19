import { useState } from "react";
import { Button, IS_MAC, KeyValue, Modal, Segmented, shortcutLabel } from "./ui";

type Area = "files" | "preview" | "assistant";
type Row = [string, string];

/** 三个工作区域共用说明入口；单字母操作始终由当前区域处理。 */
export function ShortcutsDialog({ area, kind, privateSpace = false, onClose }: { area: Area; kind?: string; privateSpace?: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Area>(area);
  const mod = (key: string) => shortcutLabel(`Mod+${key}`);
  const files: Row[] = [
    ["/", "搜索文件"], ["↑ ↓ ← →", "移动焦点；左右键用于网格，Shift 连续选择"],
    ["Home / End", "跳到第一项／最后一项"], ["↵ / 空格", "打开项目／选中或取消选中"],
    [IS_MAC ? "⌘↑" : "Alt + ↑", "返回上一级文件夹"], [mod("A"), "全选当前结果"],
    ["N", "新建文件夹"], ["U", "打开上传菜单"], ["R", "刷新当前文件列表"], ["V", "切换列表／网格视图"],
    ["M", "移动所选项目或焦点项目"], ["D", "下载所选项目或焦点项目"],
    ...(!privateSpace ? [["S", "公开分享或管理分享"] as Row] : []),
    ["F2", "重命名焦点项目"], [IS_MAC ? "⌘⌫ / Delete" : "Delete / Backspace", "移到回收站，执行前确认"],
    [shortcutLabel("Shift+F10"), "打开焦点项目的操作菜单"], ["Esc", "取消选择；再次按下清除焦点"], ["?", "打开快捷键说明"],
  ];
  const preview: Row[] = [
    ["F", "全屏／退出全屏；不支持时切换最大化"], [shortcutLabel("Shift+F"), "最大化／还原窗口"],
    ["I", "最小化／恢复窗口"], ["P", "固定／取消固定窗口"], ["D", "下载当前文件"],
    ...(!privateSpace ? [["S", "分享当前文件（支持分享时）"] as Row] : []),
    ...(!kind || kind === "text" || kind === "code" ? [
      ["T", "Markdown 预览／源码切换"], ["O", "打开／收起 Markdown 目录"],
      ["W", "源码自动换行开关"], [mod("F"), "查找源码或纯文本"],
    ] as Row[] : []),
    ...(!kind || kind === "pdf" ? [["O / G", "PDF 目录／聚焦页码"], ["← / →", "PDF 上一页／下一页，也可用 PageUp／PageDown"], ["Home / End", "PDF 第一页／最后一页"], [IS_MAC ? "⌘+ / ⌘− / ⌘0" : "Ctrl + + / − / 0", "PDF 放大／缩小／适合宽度"]] as Row[] : []),
    ...(!kind || kind === "image" || kind === "audio" || kind === "video" ? [["← →", "上一个／下一个同类文件"]] as Row[] : []),
    ...(!kind || kind === "image" ? [["+ / − / 0 / R", "图片放大／缩小／适应窗口／旋转"]] as Row[] : []),
    ...(!kind || kind === "audio" || kind === "video" ? [["空格 / K", "播放／暂停"], ["J / L", "后退／前进 10 秒"], ["↑ / ↓", "增加／减少音量"], ["O", "打开／收起播放列表"]] as Row[] : []),
    ["Esc", "退出全屏或关闭预览；固定窗口保留"], ["?", "打开快捷键说明"],
  ];
  const assistant: Row[] = [
    [mod("J"), "打开／关闭文件助手"], [mod("Shift+O"), "新对话；私密对话会清除当前内容"],
    ["H", "切换／聚焦对话历史（普通对话）"], ["/", "聚焦消息输入框"],
    ["Enter", "发送消息；列表、代码块内继续编辑"], [mod("Enter"), "直接发送消息"], [shortcutLabel("Shift+Enter"), "输入换行"],
    ["@", "引用文件或文件夹"], ["Esc", "先收起候选或菜单，再停止生成；空闲时关闭抽屉"], ["?", "打开快捷键说明"],
  ];
  return <Modal title="键盘快捷键" icon="keyboard" size="md" className={`shortcuts-dialog${area === "assistant" ? " assistant-dialog" : ""}`} onClose={onClose}
    footer={<Button onClick={onClose}>知道了</Button>}>
    <Segmented label="快捷键使用区域" value={tab} onChange={setTab} options={[{ value: "files", label: "文件浏览" }, { value: "preview", label: "文件预览" }, { value: "assistant", label: "文件助手" }]} />
    <KeyValue items={(tab === "files" ? files : tab === "preview" ? preview : assistant).map(([key, description]) => [<kbd>{key}</kbd>, description])} />
    <p className="field-hint shortcut-note">单字母快捷键只在当前区域的非输入位置生效。输入文字、操作菜单或打开其他弹窗时保留原有按键行为；助手的组合键可在输入中使用。</p>
  </Modal>;
}
