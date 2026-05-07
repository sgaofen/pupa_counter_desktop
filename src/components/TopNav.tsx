import React from "react";
import { Icons } from "./icons";
import { SessionPicker } from "./SessionPicker";

export type TabName = "Scan" | "Database" | "Settings";
const TABS: TabName[] = ["Scan", "Database", "Settings"];

interface Props {
  activeTab: TabName;
  onTabChange: (tab: TabName) => void;
  darkMode: boolean;
  onToggleDark: () => void;
  operatorInitials: string;
  onToast?: (msg: string) => void;
}

export function TopNav({ activeTab, onTabChange, darkMode, onToggleDark, operatorInitials, onToast }: Props) {
  return (
    <div className="topnav">
      <div className="brand">
        <div className="logo">{Icons.logo}</div>
        <div className="brandname">Pupa Counter</div>
        <span className="beta">Beta</span>
      </div>
      <div className="tabs">
        {TABS.map((t) => (
          <button
            key={t}
            className={`tab ${activeTab === t ? "active" : ""}`}
            onClick={() => onTabChange(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="topnav-right">
        <SessionPicker onToast={onToast} />
        <button className="iconbtn" title="Toggle theme" onClick={onToggleDark}>
          {darkMode ? Icons.sun : Icons.moon}
        </button>
        <div className="avatar" title="Operator">{operatorInitials}</div>
      </div>
    </div>
  );
}
