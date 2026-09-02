import { useCallback, useEffect, useState } from "react";
import { ArrowSyncRegular, WrenchRegular } from "@fluentui/react-icons";
import { apiMessage } from "../../api";
import { Button, Tag, message } from "../ui";
import { useI18n } from "../../lib/i18n";
import {
  getDJITopology,
  repairDeviceDJIQMI,
  runLatencyTest,
  type DJIRepairAuditWire,
  type DJIUSBInterfaceWire,
  type LatencyTestResult,
} from "./deviceActions";
import type { DeviceDetail } from "./types";

const INTERFACE_ROLES: Record<number, string> = {
  0: "DIAG",
  1: "NMEA",
  2: "AT",
  3: "Modem",
  4: "QMI",
};

function interfaceState(iface: DJIUSBInterfaceWire): "ok" | "bad" | "neutral" {
  if (iface.driver === "option" || iface.driver === "qmi_wwan") return "ok";
  if (iface.driver === "missing" || iface.driver === "") return "bad";
  return "neutral";
}

function djiTopologyHealthy(interfaces: DJIUSBInterfaceWire[]): boolean {
  let atOk = false;
  let qmiOk = false;
  for (const iface of interfaces) {
    if (iface.index === 2 && iface.serialNode) atOk = true;
    if (iface.index === 4 && iface.qmiNode) qmiOk = true;
  }
  return atOk && qmiOk;
}

export function DjiHealthCard({ device }: { device: DeviceDetail }) {
  const { t } = useI18n();
  const [topology, setTopology] = useState<DJIUSBInterfaceWire[]>([]);
  const [audit, setAudit] = useState<DJIRepairAuditWire[]>([]);
  const [loading, setLoading] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [latency, setLatency] = useState<LatencyTestResult | null>(null);
  const [latencyRunning, setLatencyRunning] = useState(false);
  const [topologyError, setTopologyError] = useState("");

  const load = useCallback(async () => {
    if (!device.id) return;
    setLoading(true);
    setTopologyError("");
    try {
      const data = await getDJITopology(device.id);
      setTopology(data.topology?.interfaces || []);
      setAudit(data.audit || []);
    } catch (err) {
      setTopologyError(apiMessage(err));
    } finally {
      setLoading(false);
    }
  }, [device.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRepair() {
    if (!device.id) return;
    setRepairing(true);
    try {
      const result = await repairDeviceDJIQMI(device.id);
      message.success(t("DJI QMI 绑定修复成功") + (result.atDevice ? `（${result.atDevice}）` : ""));
      await load();
    } catch (err) {
      message.error(apiMessage(err));
    } finally {
      setRepairing(false);
    }
  }

  async function handleLatency() {
    if (!device.id) return;
    setLatencyRunning(true);
    setLatency(null);
    try {
      const result = await runLatencyTest(device.id);
      setLatency(result);
    } catch (err) {
      message.error(apiMessage(err));
    } finally {
      setLatencyRunning(false);
    }
  }

  const healthy = topology.length > 0 && djiTopologyHealthy(topology);
  const needsDialHint = !!device.networkEnabled && device.networkPhase !== "connected" && device.networkPhase !== "disabled" && !!device.networkPhase;
  const formatTime = (value: string) => {
    try {
      return new Date(value).toLocaleString();
    } catch {
      return value;
    }
  };

  return (
    <div className="ui-panel-muted p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-gray-500">
          {t("DJI 4G 模块 USB 组态")}
          {topology.length > 0 ? <Tag type={healthy ? "success" : "danger"}>{healthy ? t("组态正常") : t("组态异常")}</Tag> : null}
        </div>
        <div className="flex gap-2">
          <Button size="small" loading={loading} onClick={load} icon={<ArrowSyncRegular />}>
            {t("重新扫描")}
          </Button>
          <Button size="small" variant="warning" plain loading={repairing} onClick={handleRepair} icon={<WrenchRegular />}>
            {t("修复 DJI QMI 绑定")}
          </Button>
        </div>
      </div>

      {needsDialHint ? (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {t("该模块需要正确的 APN 并开启数据网络才能建立数据连接；SMS 不依赖数据连接。")}
        </div>
      ) : null}

      {topologyError ? (
        <div className="mb-3 text-xs text-red-600">{topologyError}</div>
      ) : loading ? (
        <div className="mb-3 text-xs text-gray-400">{t("正在读取 USB 组态…")}</div>
      ) : topology.length > 0 ? (
        <div className="mb-3 overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="text-gray-400">
                <th className="py-1 pr-3 font-medium">{t("接口")}</th>
                <th className="py-1 pr-3 font-medium">{t("驱动")}</th>
                <th className="py-1 font-medium">{t("节点")}</th>
              </tr>
            </thead>
            <tbody>
              {topology.map((iface) => {
                const state = interfaceState(iface);
                const node =
                  iface.serialNode || iface.qmiNode || iface.networkInterface || "—";
                return (
                  <tr key={iface.index} className="border-t border-gray-100">
                    <td className="py-1 pr-3 text-gray-600">
                      <span className="font-mono">1.{iface.index}</span>
                      <span className="ml-2 text-gray-400">{INTERFACE_ROLES[iface.index] || ""}</span>
                    </td>
                    <td className="py-1 pr-3">
                      <Tag type={state === "ok" ? "success" : state === "bad" ? "danger" : "warning"}>{iface.driver || "—"}</Tag>
                    </td>
                    <td className="py-1 font-mono text-gray-600">{node}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : null}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button size="small" loading={latencyRunning} onClick={handleLatency}>
          {t("延迟诊断")}
        </Button>
        {latency ? (
          <span className="text-xs text-gray-600">
            {latency.error
              ? `${latency.target} — ${latency.error}`
              : `${latency.target} · ${t("最低")} ${latency.minMs ?? "—"}ms / ${t("平均")} ${latency.avgMs ?? "—"}ms / ${t("最高")} ${latency.maxMs ?? "—"}ms${latency.path === "interface" ? `（${latency.interface || t("模块接口")}）` : ""}`}
          </span>
        ) : null}
      </div>

      <div className="mb-3">
        <div className="mb-1 text-xs font-bold uppercase tracking-wider text-gray-500">{t("功能能力")}</div>
        <div className="flex flex-wrap gap-1.5">
          <Tag type="success">{t("SMS 短信")}</Tag>
          <Tag type="success">{t("移动数据（需 APN）")}</Tag>
          <Tag type="success">{t("飞行模式")}</Tag>
          <Tag type="info">{t("VoWiFi（视固件）")}</Tag>
          <Tag type="danger">{t("eSIM 不支持（物理 SIM）")}</Tag>
        </div>
      </div>

      <div>
        <div className="mb-1 text-xs font-bold uppercase tracking-wider text-gray-500">{t("最近修复记录")}</div>
        {audit.length === 0 ? (
          <div className="text-xs text-gray-400">{t("暂无修复记录")}</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {audit.slice(0, 5).map((entry) => (
              <li key={entry.id} className="flex items-start justify-between gap-2">
                <span className="flex items-center gap-2">
                  <Tag type={entry.outcome === "success" ? "success" : "danger"}>
                    {entry.outcome === "success" ? t("成功") : t("失败")}
                  </Tag>
                  <span className="font-mono text-gray-500">
                    {typeof entry.details?.atDevice === "string" ? entry.details.atDevice : (entry.details?.controlDevice as string) || ""}
                  </span>
                  {typeof entry.details?.error === "string" ? <span className="text-red-500">{entry.details.error}</span> : null}
                </span>
                <span className="shrink-0 text-gray-400">{formatTime(entry.createdAt)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}