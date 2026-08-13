"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Sidebar } from "@/components/sidebar";
import { TopNav } from "@/components/top-nav";

type RunItem = {
  id: string;
  project_id: string;
  project_name: string;
  model: string;
  status: string;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "failed":
      return "border-red-500/30 bg-red-500/10 text-red-200";
    case "running":
    case "executing":
    case "planning":
    case "validating":
    case "repairing":
      return "border-cyan-500/30 bg-cyan-500/10 text-cyan-100";
    default:
      return "border-white/15 bg-white/5 text-[#C9CBD4]";
  }
}

export default function AgentsPage() {
  const [runs, setRuns] = useState<RunItem[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/runs");
        const data = (await response.json()) as { runs: RunItem[]; error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? "Failed to load runs");
        }
        setRuns(data.runs);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load runs");
      }
    })();
  }, []);

  return (
    <div className="min-h-screen bg-[#0B0B0F]">
      <Sidebar activeItem="agents" />
      <TopNav variant="home" />

      <main className="pl-[72px] pt-20 px-8 pb-8">
        <div className="max-w-6xl mx-auto">
          <div className="mb-6">
            <h1 className="text-2xl font-semibold text-[#E6E6EB]">Agent Runs</h1>
            <p className="text-sm text-[#9CA3AF] mt-1">Live and recent build execution history.</p>
          </div>

          {error ? (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-2xl border border-white/10 bg-[#111218]">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="bg-white/5 text-[#9CA3AF] text-left">
                <tr>
                  <th className="px-4 py-3 font-medium">Project</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Model</th>
                  <th className="px-4 py-3 font-medium">Created</th>
                  <th className="px-4 py-3 font-medium">Open</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-t border-white/5 text-[#E6E6EB]">
                    <td className="px-4 py-3">{run.project_name}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex items-center rounded-md border px-2 py-1 text-xs ${statusBadgeClass(
                          run.status
                        )}`}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#9CA3AF]">
                      <span className="inline-flex max-w-[240px] truncate rounded-md border border-white/10 bg-white/5 px-2 py-1 text-xs text-[#C9CBD4]">
                        {run.model || "unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#9CA3AF]">{new Date(run.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <Link className="text-purple-300 hover:text-purple-200" href={`/sandbox?projectId=${run.project_id}`}>
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
