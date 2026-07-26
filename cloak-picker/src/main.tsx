import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./styles.css";

/// Without this, one render-time throw leaves an empty window with no way back:
/// a corrupt .cloak-created-at, for instance, reaches Intl.DateTimeFormat as an
/// out-of-range Date and takes the whole picker down.
class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { message: string }
> {
  state = { message: "" };

  static getDerivedStateFromError(error: unknown) {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  render() {
    if (!this.state.message) return this.props.children;
    return (
      <div className="crashState" role="alert">
        <strong>选择器遇到未处理的错误</strong>
        <p>{this.state.message}</p>
        <p className="crashHint">账号数据没有被改动。重新加载即可继续。</p>
        <button className="subtleButton" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
