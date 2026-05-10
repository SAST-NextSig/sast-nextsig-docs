"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

const PALETTE = [
  "#6366f1",
  "#22d3ee",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#a855f7",
];

const tooltipStyle = {
  contentStyle: {
    background: "var(--color-fd-card)",
    border: "1px solid var(--color-fd-border)",
    borderRadius: 8,
    fontSize: 12,
  } as React.CSSProperties,
  labelStyle: { color: "var(--color-fd-foreground)" } as React.CSSProperties,
  itemStyle: { color: "var(--color-fd-foreground)" } as React.CSSProperties,
};

export function LineChartDemo() {
  const data = [
    { week: "W1", visits: 320, signups: 24 },
    { week: "W2", visits: 410, signups: 31 },
    { week: "W3", visits: 380, signups: 27 },
    { week: "W4", visits: 520, signups: 48 },
    { week: "W5", visits: 610, signups: 56 },
    { week: "W6", visits: 740, signups: 71 },
  ];
  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-fd-border)" />
        <XAxis
          dataKey="week"
          stroke="var(--color-fd-muted-foreground)"
          fontSize={12}
        />
        <YAxis stroke="var(--color-fd-muted-foreground)" fontSize={12} />
        <Tooltip {...tooltipStyle} />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Line
          type="monotone"
          dataKey="visits"
          stroke={PALETTE[0]}
          strokeWidth={2}
          dot={{ r: 3 }}
          name="访问"
        />
        <Line
          type="monotone"
          dataKey="signups"
          stroke={PALETTE[1]}
          strokeWidth={2}
          dot={{ r: 3 }}
          name="注册"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

export function BarChartDemo() {
  const data = [
    { topic: "AI", count: 42 },
    { topic: "网络", count: 28 },
    { topic: "代理", count: 19 },
    { topic: "OS", count: 15 },
    { topic: "安全", count: 11 },
  ];
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-fd-border)" />
        <XAxis
          dataKey="topic"
          stroke="var(--color-fd-muted-foreground)"
          fontSize={12}
        />
        <YAxis stroke="var(--color-fd-muted-foreground)" fontSize={12} />
        <Tooltip {...tooltipStyle} />
        <Bar dataKey="count" radius={[6, 6, 0, 0]}>
          {data.map((d, i) => (
            <Cell key={d.topic} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

export function PieChartDemo() {
  const data = [
    { name: "AI / Agents", value: 38 },
    { name: "网络 / 代理", value: 27 },
    { name: "操作系统", value: 18 },
    { name: "其他", value: 17 },
  ];
  return (
    <ResponsiveContainer width="100%" height={280}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="name"
          innerRadius={60}
          outerRadius={100}
          paddingAngle={2}
          stroke="var(--color-fd-card)"
        >
          {data.map((d, i) => (
            <Cell key={d.name} fill={PALETTE[i % PALETTE.length]} />
          ))}
        </Pie>
        <Legend wrapperStyle={{ fontSize: 12 }} />
        <Tooltip {...tooltipStyle} />
      </PieChart>
    </ResponsiveContainer>
  );
}

export function AreaChartDemo() {
  const data = [
    { month: "1 月", commits: 18 },
    { month: "2 月", commits: 26 },
    { month: "3 月", commits: 31 },
    { month: "4 月", commits: 47 },
    { month: "5 月", commits: 62 },
  ];
  return (
    <ResponsiveContainer width="100%" height={260}>
      <AreaChart data={data} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
        <defs>
          <linearGradient id="fillCommits" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={PALETTE[0]} stopOpacity={0.45} />
            <stop offset="100%" stopColor={PALETTE[0]} stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-fd-border)" />
        <XAxis
          dataKey="month"
          stroke="var(--color-fd-muted-foreground)"
          fontSize={12}
        />
        <YAxis stroke="var(--color-fd-muted-foreground)" fontSize={12} />
        <Tooltip {...tooltipStyle} />
        <Area
          type="monotone"
          dataKey="commits"
          stroke={PALETTE[0]}
          strokeWidth={2}
          fill="url(#fillCommits)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

export function RadarChartDemo() {
  const data = [
    { subject: "前端", value: 85 },
    { subject: "后端", value: 70 },
    { subject: "AI", value: 78 },
    { subject: "网络", value: 65 },
    { subject: "DevOps", value: 60 },
    { subject: "安全", value: 55 },
  ];
  return (
    <ResponsiveContainer width="100%" height={280}>
      <RadarChart data={data}>
        <PolarGrid stroke="var(--color-fd-border)" />
        <PolarAngleAxis
          dataKey="subject"
          stroke="var(--color-fd-muted-foreground)"
          fontSize={12}
        />
        <PolarRadiusAxis tick={false} axisLine={false} />
        <Radar
          name="兴趣分布"
          dataKey="value"
          stroke={PALETTE[0]}
          fill={PALETTE[0]}
          fillOpacity={0.3}
        />
        <Tooltip {...tooltipStyle} />
      </RadarChart>
    </ResponsiveContainer>
  );
}
