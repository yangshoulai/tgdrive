/** 按需加载的页面：构建器把 import() 的目标打成独立分块（build-apps.mjs），这里统一处理加载中与加载失败。 */
import { Component, Suspense, lazy, type ComponentType, type ReactNode } from "react";
import { Button, EmptyState } from "./ui";

/** 包装 import()：取模块里的一个导出作为组件。 */
export function lazyComponent<P extends object, M>(load: () => Promise<M>, pick: (module: M) => ComponentType<P>) {
  return lazy(async () => ({ default: pick(await load()) }));
}

/** 空闲时预先下载分块（不执行组件），点开时不用再等网络。 */
export function preload(load: () => Promise<unknown>) {
  const run = () => void load().catch(() => undefined);
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 4000 });
  else setTimeout(run, 1500);
}

type BoundaryState = { failed: boolean };

/** 分块下载失败（网络中断、部署后旧分块已删除）时给出重新加载，而不是让整个应用白屏。 */
class LoadBoundary extends Component<{ children: ReactNode; quiet?: boolean }, BoundaryState> {
  state: BoundaryState = { failed: false };
  static getDerivedStateFromError(): BoundaryState { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    if (this.props.quiet) return null;
    return <EmptyState icon="alert" title="页面组件没有加载成功" description="可能是网络中断，或者服务刚刚更新。重新加载页面即可。"
      action={<Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>重新加载</Button>} />;
  }
}

/** fallback 为 null 时（如抽屉）加载失败也保持安静，不在页面上插入提示。 */
export function Loadable({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  return <LoadBoundary quiet={fallback === null}><Suspense fallback={fallback}>{children}</Suspense></LoadBoundary>;
}
