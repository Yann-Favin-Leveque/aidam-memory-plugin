#!/usr/bin/env python3
"""
/aidam-usage — AIDAM Usage Report (direct script, no LLM)
Queries orchestrator_state + agent_usage and prints formatted report to stderr.
"""
import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "mcp"))
import memory_pg as mem

def main():
    # Find running orchestrator
    orch_rows = mem.select_query(
        "SELECT session_id, pid, status, started_at, last_heartbeat_at "
        "FROM orchestrator_state WHERE status = 'running' "
        "ORDER BY last_heartbeat_at DESC NULLS LAST LIMIT 1"
    )
    if not orch_rows:
        print("No running AIDAM orchestrator found.", file=sys.stderr)
        return

    o = orch_rows[0]
    session_id = o["session_id"]

    # Get per-agent usage
    usage_rows = mem.select_query(
        "SELECT agent_name, invocation_count, total_cost_usd, last_cost_usd, "
        "budget_per_call, status "
        "FROM agent_usage WHERE session_id = %s ORDER BY agent_name",
        (session_id,)
    )

    total_cost = sum(float(r.get("total_cost_usd", 0) or 0) for r in usage_rows)
    session_budget = 5.0

    # Format report
    lines = []
    lines.append("AIDAM Usage Report")
    lines.append("==================")
    lines.append("")
    lines.append(f"  Session:    {session_id[:12]}")
    lines.append(f"  PID:        {o.get('pid', '?')}")
    lines.append(f"  Started:    {o.get('started_at', '?')}")
    lines.append(f"  Heartbeat:  {o.get('last_heartbeat_at', '?')}")
    lines.append("")
    lines.append("  Agent           Calls   Cost      Last      Budget/call   Status")
    lines.append("  -----------     -----   -------   -------   -----------   --------")

    for r in usage_rows:
        name = (r.get("agent_name") or "?").ljust(15)
        calls = str(r.get("invocation_count", 0)).rjust(5)
        cost = f"${float(r.get('total_cost_usd', 0) or 0):.4f}".rjust(8)
        last = f"${float(r.get('last_cost_usd', 0) or 0):.4f}".rjust(8) if r.get("invocation_count", 0) else "      --"
        budget = f"${float(r.get('budget_per_call', 0) or 0):.2f}".rjust(12)
        status = r.get("status", "?")
        lines.append(f"  {name} {calls}   {cost}  {last}  {budget}   {status}")

    lines.append("")
    lines.append(f"  Total cost:     ${total_cost:.4f}")
    lines.append(f"  Session budget: ${session_budget:.2f}")
    lines.append(f"  Remaining:      ${session_budget - total_cost:.4f}")

    print("\n".join(lines), file=sys.stderr)

if __name__ == "__main__":
    main()
