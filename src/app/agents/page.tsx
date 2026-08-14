"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { TopBar } from "@/components/top-bar";
import { cn } from "@/lib/utils";

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
      return "border-[#1a7f37]/20 bg-[#1a7f37]/10 text-[#1a7f37]";
    case "failed":
      return "border-[#d1242f]/20 bg-[#d1242f]/10 text-[#d1242f]";
    case "running":
    case "executing":
    case "planning":
    case "validating":
    case "repairing":
      return "border-[#0071e3]/20 bg-[#0071e3]/10 text-[#0071e3]";
    default:
      return "border-black/[0.08] bg-black/[0.03] text-[#6e6e73]";
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
    <div className="min-h-screen bg-[#fafafa]">
      <TopBar variant="marketing" />

      <main className="px-6 py-12">
        <div className="max-w-5xl mx-auto">
          <div className="mb-6">
            <h1 className="text-title text-[#1d1d1f]">Run history</h1>
            <p className="text-[13px] text-[#86868b] mt-1">Every run across every project, newest first.</p>
          </div>

          {error ? (
            <div role="alert" className="mb-4 rounded-[12px] border border-[#d1242f]/20 bg-[#d1242f]/5 px-4 py-3 text-sm text-[#d1242f]">
              {error}
            </div>
          ) : null}

          <div className="overflow-x-auto rounded-[14px] border border-black/[0.08] bg-white shadow-sm">
            <table className="w-full min-w-[760px] text-[13px]">
              <thead className="bg-[#f5f5f7] text-[#6e6e73] text-left">
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
                  <tr key={run.id} className="border-t border-black/[0.06] text-[#1d1d1f]">
                    <td className="px-4 py-3">{run.project_name}</td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
                          statusBadgeClass(run.status)
                        )}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#6e6e73]">
                      <span className="inline-flex max-w-[240px] truncate rounded-[6px] border border-black/[0.08] bg-[#f5f5f7] px-2 py-0.5 font-mono text-[11px] text-[#6e6e73]">
                        {run.model || "unknown"}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-[#6e6e73]">{new Date(run.created_at).toLocaleString()}</td>
                    <td className="px-4 py-3">
                      <Link
                        className="font-medium text-[#0071e3] hover:text-[#0058b0] rounded-[6px]"
                        href={`/sandbox?projectId=${run.project_id}`}
                      >
                        Open
                      </Link>
                    </td>
                  </tr>
                ))}
                {runs.length === 0 && !error ? (
                  <tr>
                    <td colSpan={5} className="px-4 py-10 text-center text-[#86868b]">
                      No runs yet.
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
