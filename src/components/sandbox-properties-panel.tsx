"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import * as Slider from "@radix-ui/react-slider";
import {
    Layout,
    Type,
    Palette,
    Sparkles,
    MousePointer2,
    AlignLeft,
    AlignCenter,
    AlignRight,
    ChevronDown,
    Box
} from "lucide-react";
import { cn } from "@/lib/utils";

export function SandboxPropertiesPanel() {
    const [selectedElement, setSelectedElement] = React.useState<string | null>(null);

    // Mock selection after delay
    React.useEffect(() => {
        const timer = setTimeout(() => {
            setSelectedElement("Hero Section");
        }, 1000);
        return () => clearTimeout(timer);
    }, []);

    return (
        <div className="flex flex-col h-full bg-[#0B0B0F] border-l border-white/6 w-[280px]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-white/6">
                <h2 className="text-sm font-medium text-[#E6E6EB]">Properties</h2>
                <div className="flex items-center gap-2">
                    {selectedElement && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30">
                            {selectedElement}
                        </span>
                    )}
                </div>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                <AnimatePresence mode="wait">
                    {selectedElement ? (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="p-4 space-y-6"
                        >
                            <PropertySection title="Layout" icon={Layout} defaultOpen>
                                <LayoutControls />
                            </PropertySection>

                            <PropertySection title="Spacing" icon={Box} defaultOpen>
                                <SpacingControls />
                            </PropertySection>

                            <PropertySection title="Typography" icon={Type}>
                                <TypographyControls />
                            </PropertySection>

                            <PropertySection title="Styles" icon={Palette}>
                                <ColorControls />
                            </PropertySection>

                            <PropertySection title="Effects" icon={Sparkles}>
                                <EffectControls />
                            </PropertySection>
                        </motion.div>
                    ) : (
                        <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            className="h-full flex flex-col items-center justify-center p-6 text-center"
                        >
                            <div className="w-16 h-16 rounded-2xl bg-white/5 flex items-center justify-center mb-4 border border-white/5">
                                <MousePointer2 className="w-6 h-6 text-[#6B7280]" />
                            </div>
                            <p className="text-sm font-medium text-[#E6E6EB] mb-1">No Selection</p>
                            <p className="text-xs text-[#6B7280]">
                                Click any element on the canvas to customize it.
                            </p>
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
}

function PropertySection({
    title,
    icon: Icon,
    children,
    defaultOpen = false
}: {
    title: string,
    icon: React.ComponentType<{ className?: string }>,
    children: React.ReactNode,
    defaultOpen?: boolean
}) {
    const [isOpen, setIsOpen] = React.useState(defaultOpen);

    return (
        <div className="space-y-3">
            <button
                onClick={() => setIsOpen(!isOpen)}
                className="flex items-center justify-between w-full group"
            >
                <div className="flex items-center gap-2 text-xs font-medium text-[#9CA3AF] group-hover:text-[#E6E6EB] transition-colors">
                    <Icon className="w-3.5 h-3.5" />
                    {title}
                </div>
                <ChevronDown className={cn(
                    "w-3.5 h-3.5 text-[#6B7280] transition-transform duration-200",
                    isOpen ? "rotate-180" : ""
                )} />
            </button>

            <AnimatePresence>
                {isOpen && (
                    <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden"
                    >
                        <div className="space-y-4 pt-1">
                            {children}
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}

function LayoutControls() {
    const [display, setDisplay] = React.useState("flex");
    return (
        <div className="space-y-3">
            <div className="grid grid-cols-3 gap-1 p-1 rounded-lg bg-[#111218] border border-white/10">
                {["flex", "grid", "block"].map((d) => (
                    <button
                        key={d}
                        onClick={() => setDisplay(d)}
                        className={cn(
                            "py-1 rounded text-[10px] font-medium transition-all",
                            display === d
                                ? "bg-purple-500/20 text-purple-300 shadow-sm"
                                : "text-[#6B7280] hover:text-[#E6E6EB]"
                        )}
                    >
                        {d.toUpperCase()}
                    </button>
                ))}
            </div>

            <div className="flex items-center justify-between gap-2">
                <div className="flex gap-1 bg-[#111218] rounded-md border border-white/10 p-0.5">
                    {[AlignLeft, AlignCenter, AlignRight].map((Icon, i) => (
                        <button key={i} className="p-1.5 rounded hover:bg-white/5 text-[#9CA3AF] hover:text-[#E6E6EB]">
                            <Icon className="w-3.5 h-3.5" />
                        </button>
                    ))}
                </div>
                <div className="flex-1">
                    {/* Placeholder for gap control */}
                    <div className="h-7 rounded-md bg-[#111218] border border-white/10 w-full flex items-center px-2 text-xs text-[#9CA3AF]">
                        Gap: 16px
                    </div>
                </div>
            </div>
        </div>
    );
}

function SpacingControls() {
    return (
        <div className="space-y-3">
            <SliderControl label="Padding" value={[24]} />
            <SliderControl label="Margin" value={[0]} />
        </div>
    );
}

function TypographyControls() {
    return (
        <div className="space-y-3">
            <div className="flex gap-2">
                <select className="flex-1 bg-[#111218] border border-white/10 rounded-md text-xs text-[#E6E6EB] p-1.5 outline-none">
                    <option>Inter</option>
                    <option>Roboto</option>
                    <option>Mono</option>
                </select>
                <select className="w-20 bg-[#111218] border border-white/10 rounded-md text-xs text-[#E6E6EB] p-1.5 outline-none">
                    <option>Reg</option>
                    <option>Bold</option>
                </select>
            </div>
            <SliderControl label="Size" value={[16]} unit="px" max={64} />
            <SliderControl label="Height" value={[1.5]} max={3} step={0.1} />
        </div>
    );
}

function ColorControls() {
    return (
        <div className="grid grid-cols-5 gap-2">
            {["#fff", "#0B0B0F", "#6366F1", "#10B981", "#EF4444"].map((c, i) => (
                <button
                    key={i}
                    className="aspect-square rounded-md border border-white/10 hover:scale-110 transition-transform"
                    style={{ backgroundColor: c }}
                />
            ))}
        </div>
    );
}

function EffectControls() {
    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between text-xs text-[#9CA3AF]">
                <span>Border Radius</span>
                <span>8px</span>
            </div>
            <SliderControl label="Radius" value={[8]} showLabel={false} />
            <div className="flex items-center justify-between text-xs text-[#9CA3AF] mt-2">
                <span>Opacity</span>
                <span>100%</span>
            </div>
            <SliderControl label="Opacity" value={[100]} showLabel={false} />
        </div>
    );
}

function SliderControl({
    label,
    value,
    max = 100,
    step = 1,
    unit = "",
    showLabel = true
}: {
    label: string,
    value: number[],
    max?: number,
    step?: number,
    unit?: string,
    showLabel?: boolean
}) {
    return (
        <div>
            {showLabel && (
                <div className="flex items-center justify-between mb-2">
                    <label className="text-xs text-[#6B7280]">{label}</label>
                    <span className="text-xs text-[#E6E6EB] font-mono">{value[0]}{unit}</span>
                </div>
            )}
            <Slider.Root
                defaultValue={value}
                max={max}
                step={step}
                className="relative flex items-center w-full h-4 select-none touch-none group"
            >
                <Slider.Track className="relative grow h-0.5 rounded-full bg-white/10 group-hover:bg-white/20 transition-colors">
                    <Slider.Range className="absolute h-full rounded-full bg-gradient-to-r from-purple-500 to-cyan-500" />
                </Slider.Track>
                <Slider.Thumb className="block w-3 h-3 rounded-full bg-[#E6E6EB] shadow-lg border border-white/50 hover:bg-white focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-transform hover:scale-110" />
            </Slider.Root>
        </div>
    );
}
