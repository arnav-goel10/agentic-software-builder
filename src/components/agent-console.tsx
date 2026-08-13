"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
    Check,
    Loader2,
    Circle,
    AlertCircle,
    ChevronDown,
    ChevronRight,
    Bot,
    Sparkles,
    Send
} from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentStep {
    id: string;
    label: string;
    status: "pending" | "running" | "complete" | "error";
}

interface AgentMessage {
    id: string;
    type: "action" | "thinking" | "complete" | "error";
    content: string;
    timestamp: Date;
    steps?: AgentStep[];
}

const mockMessages: AgentMessage[] = [
    {
        id: "m1",
        type: "action",
        content: "Analyzing your requirements",
        timestamp: new Date(Date.now() - 45000),
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
        timestamp: new Date(Date.now() - 30000),
        steps: [
            { id: "s4", label: "Creating project structure", status: "complete" },
            { id: "s5", label: "Generating components", status: "complete" },
            { id: "s6", label: "Styling with design system", status: "running" },
            { id: "s7", label: "Adding interactions", status: "pending" },
            { id: "s8", label: "Optimizing performance", status: "pending" },
        ],
    },
];

export function AgentConsole() {
    const [messages] = React.useState<AgentMessage[]>(mockMessages);
    const [inputValue, setInputValue] = React.useState("");
    const scrollRef = React.useRef<HTMLDivElement>(null);

    return (
        <div className="flex flex-col h-full bg-[#0B0B0F] border-r border-white/6">
            {/* Header */}
            <div className="flex items-center gap-3 px-4 py-4 border-b border-white/6">
                <div className="relative">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-cyan-500 flex items-center justify-center">
                        <Bot className="w-4 h-4 text-white" />
                    </div>
                    <motion.div
                        className="absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full bg-emerald-500 border-2 border-[#0B0B0F]"
                        animate={{ scale: [1, 1.2, 1] }}
                        transition={{ duration: 2, repeat: Infinity }}
                    />
                </div>
                <div>
                    <h2 className="text-sm font-medium text-[#E6E6EB]">Dexter Agent</h2>
                    <p className="text-xs text-emerald-400">Active</p>
                </div>
            </div>

            {/* Messages */}
            <div
                ref={scrollRef}
                className="flex-1 overflow-y-auto px-4 py-4 space-y-4"
            >
                {messages.map((message, index) => (
                    <MessageBubble key={message.id} message={message} delay={index * 0.1} />
                ))}

                {/* Current action indicator */}
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="flex items-center gap-2 text-sm text-[#9CA3AF]"
                >
                    <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                    >
                        <Loader2 className="w-4 h-4 text-purple-400" />
                    </motion.div>
                    <span>Styling with design system...</span>
                </motion.div>
            </div>

            {/* Input */}
            <div className="p-4 border-t border-white/6">
                <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-[#111218] border border-white/8 focus-within:border-purple-500/50 transition-colors">
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder="Ask Dexter anything..."
                        className="flex-1 bg-transparent border-none outline-none text-sm text-[#E6E6EB] placeholder:text-[#6B7280]"
                    />
                    <motion.button
                        className={cn(
                            "p-1.5 rounded-lg transition-colors",
                            inputValue.trim()
                                ? "bg-purple-500 text-white"
                                : "bg-white/5 text-[#6B7280]"
                        )}
                        whileHover={{ scale: 1.05 }}
                        whileTap={{ scale: 0.95 }}
                    >
                        <Send className="w-4 h-4" />
                    </motion.button>
                </div>
            </div>
        </div>
    );
}

interface MessageBubbleProps {
    message: AgentMessage;
    delay?: number;
}

function MessageBubble({ message, delay = 0 }: MessageBubbleProps) {
    const [isExpanded, setIsExpanded] = React.useState(true);

    return (
        <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay }}
            className="space-y-2"
        >
            {/* Message header */}
            <div className="flex items-start gap-3">
                <div className="w-6 h-6 rounded-md bg-purple-500/20 flex items-center justify-center flex-shrink-0 mt-0.5">
                    <Sparkles className="w-3 h-3 text-purple-400" />
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-sm text-[#E6E6EB] font-medium">{message.content}</p>
                    <p className="text-xs text-[#6B7280] mt-0.5">
                        {message.timestamp.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </p>
                </div>
            </div>

            {/* Steps */}
            {message.steps && message.steps.length > 0 && (
                <div className="ml-9">
                    <button
                        onClick={() => setIsExpanded(!isExpanded)}
                        className="flex items-center gap-1 text-xs text-[#6B7280] hover:text-[#9CA3AF] transition-colors mb-2"
                    >
                        {isExpanded ? (
                            <ChevronDown className="w-3 h-3" />
                        ) : (
                            <ChevronRight className="w-3 h-3" />
                        )}
                        {message.steps.filter(s => s.status === "complete").length}/{message.steps.length} steps
                    </button>

                    <AnimatePresence>
                        {isExpanded && (
                            <motion.div
                                initial={{ height: 0, opacity: 0 }}
                                animate={{ height: "auto", opacity: 1 }}
                                exit={{ height: 0, opacity: 0 }}
                                transition={{ duration: 0.2 }}
                                className="space-y-1.5 overflow-hidden"
                            >
                                {message.steps.map((step) => (
                                    <StepItem key={step.id} step={step} />
                                ))}
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            )}
        </motion.div>
    );
}

function StepItem({ step }: { step: AgentStep }) {
    const statusIcons = {
        pending: <Circle className="w-3.5 h-3.5 text-[#4B5563]" />,
        running: (
            <motion.div
                animate={{ rotate: 360 }}
                transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
            >
                <Loader2 className="w-3.5 h-3.5 text-purple-400" />
            </motion.div>
        ),
        complete: <Check className="w-3.5 h-3.5 text-emerald-400" />,
        error: <AlertCircle className="w-3.5 h-3.5 text-red-400" />,
    };

    const statusColors = {
        pending: "text-[#6B7280]",
        running: "text-[#E6E6EB]",
        complete: "text-[#9CA3AF]",
        error: "text-red-400",
    };

    return (
        <motion.div
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            className={cn(
                "flex items-center gap-2 text-xs",
                statusColors[step.status]
            )}
        >
            {statusIcons[step.status]}
            <span className={step.status === "complete" ? "line-through opacity-60" : ""}>
                {step.label}
            </span>
        </motion.div>
    );
}
