import { NavLink } from "react-router-dom";

/** 底部导航项配置 */
const tabs = [
  { to: "/", label: "首页", icon: "🏠" },
  { to: "/study", label: "学习", icon: "📖" },
  { to: "/wordbook", label: "词库", icon: "📚" },
  { to: "/stats", label: "统计", icon: "📊" },
  { to: "/settings", label: "设置", icon: "⚙️" },
];

/** 固定底部导航栏（适配 iPhone 安全区） */
export function BottomNav() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-100 bg-white/95 backdrop-blur">
      <div
        className="mx-auto flex max-w-md items-stretch justify-around md:max-w-2xl"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.to === "/"}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 py-2.5 text-xs transition-colors ${
                isActive ? "text-brand-600 font-medium" : "text-slate-400"
              }`
            }
          >
            <span className="text-xl leading-none" aria-hidden>
              {tab.icon}
            </span>
            {tab.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
