/**
 * Mock Data for Dexter AI Builder
 * Premium UI demonstration data
 */

export interface Project {
    id: string;
    name: string;
    description: string;
    status: "building" | "live" | "paused" | "draft";
    lastEdited: Date;
    previewUrl: string;
    stack: string[];
}

export interface Template {
    id: string;
    name: string;
    description: string;
    category: string;
    previewUrl: string;
    popular: boolean;
}

export interface AgentMessage {
    id: string;
    type: "action" | "thinking" | "complete" | "error";
    content: string;
    timestamp: Date;
    steps?: AgentStep[];
}

export interface AgentStep {
    id: string;
    label: string;
    status: "pending" | "running" | "complete" | "error";
}

// Recent Projects
export const recentProjects: Project[] = [
    {
        id: "1",
        name: "Fintech Dashboard",
        description: "Analytics platform for crypto trading",
        status: "live",
        lastEdited: new Date(Date.now() - 3600000),
        previewUrl: "/previews/fintech.png",
        stack: ["Next.js", "TypeScript", "Supabase"],
    },
    {
        id: "2",
        name: "AI Writing Assistant",
        description: "GPT-powered content generation tool",
        status: "building",
        lastEdited: new Date(Date.now() - 7200000),
        previewUrl: "/previews/writing.png",
        stack: ["React", "OpenAI", "Tailwind"],
    },
    {
        id: "3",
        name: "E-commerce Store",
        description: "Headless commerce with Stripe",
        status: "live",
        lastEdited: new Date(Date.now() - 86400000),
        previewUrl: "/previews/ecommerce.png",
        stack: ["Next.js", "Stripe", "Prisma"],
    },
    {
        id: "4",
        name: "Team Collaboration",
        description: "Real-time project management",
        status: "paused",
        lastEdited: new Date(Date.now() - 172800000),
        previewUrl: "/previews/collab.png",
        stack: ["React", "Socket.io", "PostgreSQL"],
    },
    {
        id: "5",
        name: "Developer Portfolio",
        description: "Personal brand showcase",
        status: "draft",
        lastEdited: new Date(Date.now() - 259200000),
        previewUrl: "/previews/portfolio.png",
        stack: ["Next.js", "MDX", "Vercel"],
    },
];

// Templates
export const templates: Template[] = [
    {
        id: "t1",
        name: "SaaS Starter",
        description: "Complete SaaS boilerplate with auth, billing, and dashboard",
        category: "Business",
        previewUrl: "/templates/saas.png",
        popular: true,
    },
    {
        id: "t2",
        name: "AI Chat App",
        description: "Conversational AI interface with streaming responses",
        category: "AI/ML",
        previewUrl: "/templates/chat.png",
        popular: true,
    },
    {
        id: "t3",
        name: "Fintech Dashboard",
        description: "Trading analytics with real-time charts and data",
        category: "Finance",
        previewUrl: "/templates/fintech.png",
        popular: false,
    },
    {
        id: "t4",
        name: "Marketplace",
        description: "Two-sided marketplace with search and payments",
        category: "E-commerce",
        previewUrl: "/templates/marketplace.png",
        popular: true,
    },
    {
        id: "t5",
        name: "Developer Tool",
        description: "CLI dashboard with API management",
        category: "DevTools",
        previewUrl: "/templates/devtool.png",
        popular: false,
    },
    {
        id: "t6",
        name: "Landing Page",
        description: "High-converting landing with animations",
        category: "Marketing",
        previewUrl: "/templates/landing.png",
        popular: true,
    },
];

// Command suggestions
export const commandSuggestions = [
    "Build a fintech app with crypto portfolio tracking",
    "Create an AI-powered writing assistant",
    "Design a marketplace like Etsy",
    "Build a team collaboration tool like Linear",
    "Create a developer portfolio with blog",
    "Create a developer portfolio with blog",
    "Design a SaaS analytics dashboard",
];

export const sandboxSuggestions = [
    "Build a SaaS dashboard",
    "Create a fintech app",
    "Generate a landing page",
    "Start an AI chatbot",
];

// Agent conversation mock
export const agentConversation: AgentMessage[] = [
    {
        id: "m1",
        type: "action",
        content: "Analyzing your requirements...",
        timestamp: new Date(Date.now() - 30000),
        steps: [
            { id: "s1", label: "Parsing prompt", status: "complete" },
            { id: "s2", label: "Identifying components", status: "complete" },
            { id: "s3", label: "Planning architecture", status: "complete" },
        ],
    },
    {
        id: "m2",
        type: "action",
        content: "Building your application",
        timestamp: new Date(Date.now() - 20000),
        steps: [
            { id: "s4", label: "Creating layout structure", status: "complete" },
            { id: "s5", label: "Generating components", status: "complete" },
            { id: "s6", label: "Styling with design system", status: "running" },
            { id: "s7", label: "Adding interactions", status: "pending" },
            { id: "s8", label: "Optimizing performance", status: "pending" },
        ],
    },
];

export const sandboxAgentSteps: AgentStep[] = [
    { id: "sb1", label: "Initializing builder core", status: "complete" },
    { id: "sb2", label: "Loading design tokens", status: "complete" },
    { id: "sb3", label: "Connecting to AI model", status: "running" },
    { id: "sb4", label: "Preparing canvas", status: "pending" },
];

// Sidebar navigation items
export const sidebarItems = [
    { id: "home", label: "Home", icon: "Home" },
    { id: "projects", label: "Projects", icon: "FolderKanban" },
    { id: "agents", label: "Agents", icon: "Bot" },
    { id: "templates", label: "Templates", icon: "LayoutTemplate" },
    { id: "deployments", label: "Deployments", icon: "Rocket" },
    { id: "analytics", label: "Analytics", icon: "BarChart3" },
    { id: "settings", label: "Settings", icon: "Settings" },
];
