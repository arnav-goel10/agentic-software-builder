"use client";

import * as React from "react";
import { motion } from "framer-motion";
import * as Slider from "@radix-ui/react-slider";
import {
    MousePointer2,
    Type,
    Palette,
    Square,
    Layout,
    AlignLeft,
    AlignCenter,
    AlignRight,
    ChevronDown,
    ChevronRight
} from "lucide-react";
import { cn } from "@/lib/utils";

interface PropertySection {
    id: string;
    label: string;
    icon: React.ReactNode;
    defaultOpen?: boolean;
}

const sections: PropertySection[] = [
    { id: "layout", label: "Layout", icon: <Layout className="w-4 h-4" />, defaultOpen: true },
    { id: "spacing", label: "Spacing", icon: <Square className="w-4 h-4" />, defaultOpen: true },
    { id: "typography", label: "Typography", icon: <Type className="w-4 h-4" /> },
    { id: "colors", label: "Colors", icon: <Palette className="w-4 h-4" /> },
];

export function PropertiesPanel() {
    const [selectedElement] = React.useState<string | null>("hero-title");
    const [openSections, setOpenSections] = React.useState<string[]>(["layout", "spacing"]);

    const toggleSection = (id: string) => {
        setOpenSections((prev) =>
            prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
        );
    };

    return (
        <div className="flex flex-col h-full bg-[#0B0B0F] border-l border-white/6 w-[280px]">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-4 border-b border-white/6">
                <h2 className="text-sm font-medium text-[#E6E6EB]">Properties</h2>
                {selectedElement && (
                    <span className="text-xs text-[#6B7280] px-2 py-0.5 rounded bg-white/5">
                        {selectedElement}
                    </span>
                )}
            </div>

            {/* Content */}
            {selectedElement ? (
                <div className="flex-1 overflow-y-auto">
                    {sections.map((section) => (
                        <PropertySectionComponent
                            key={section.id}
                            section={section}
                            isOpen={openSections.includes(section.id)}
                            onToggle={() => toggleSection(section.id)}
                        />
                    ))}
                </div>
            ) : (
                <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
                    <div className="w-12 h-12 rounded-xl bg-white/5 flex items-center justify-center mb-4">
                        <MousePointer2 className="w-6 h-6 text-[#6B7280]" />
                    </div>
                    <p className="text-sm text-[#9CA3AF] mb-1">No element selected</p>
                    <p className="text-xs text-[#6B7280]">Click on an element in the preview to edit its properties</p>
                </div>
            )}
        </div>
    );
}

function PropertySectionComponent({
    section,
    isOpen,
    onToggle,
}: {
    section: PropertySection;
    isOpen: boolean;
    onToggle: () => void;
}) {
    return (
        <div className="border-b border-white/6">
            <button
                onClick={onToggle}
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-white/3 transition-colors"
            >
                <div className="flex items-center gap-2 text-sm text-[#E6E6EB]">
                    {section.icon}
                    {section.label}
                </div>
                {isOpen ? (
                    <ChevronDown className="w-4 h-4 text-[#6B7280]" />
                ) : (
                    <ChevronRight className="w-4 h-4 text-[#6B7280]" />
                )}
            </button>

            {isOpen && (
                <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: "auto", opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.2 }}
                    className="px-4 pb-4 space-y-4"
                >
                    {section.id === "layout" && <LayoutControls />}
                    {section.id === "spacing" && <SpacingControls />}
                    {section.id === "typography" && <TypographyControls />}
                    {section.id === "colors" && <ColorControls />}
                </motion.div>
            )}
        </div>
    );
}

function LayoutControls() {
    const [display, setDisplay] = React.useState("flex");
    const [align, setAlign] = React.useState("center");

    return (
        <div className="space-y-3">
            {/* Display */}
            <div>
                <label className="text-xs text-[#6B7280] mb-2 block">Display</label>
                <div className="flex gap-1">
                    {["block", "flex", "grid"].map((d) => (
                        <button
                            key={d}
                            onClick={() => setDisplay(d)}
                            className={cn(
                                "flex-1 py-1.5 rounded-md text-xs font-medium transition-colors",
                                display === d
                                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                    : "bg-white/5 text-[#9CA3AF] border border-white/10 hover:bg-white/8"
                            )}
                        >
                            {d}
                        </button>
                    ))}
                </div>
            </div>

            {/* Align */}
            <div>
                <label className="text-xs text-[#6B7280] mb-2 block">Align</label>
                <div className="flex gap-1">
                    {[
                        { id: "left", icon: <AlignLeft className="w-4 h-4" /> },
                        { id: "center", icon: <AlignCenter className="w-4 h-4" /> },
                        { id: "right", icon: <AlignRight className="w-4 h-4" /> },
                    ].map((a) => (
                        <button
                            key={a.id}
                            onClick={() => setAlign(a.id)}
                            className={cn(
                                "flex-1 py-2 rounded-md flex items-center justify-center transition-colors",
                                align === a.id
                                    ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                                    : "bg-white/5 text-[#9CA3AF] border border-white/10 hover:bg-white/8"
                            )}
                        >
                            {a.icon}
                        </button>
                    ))}
                </div>
            </div>
        </div>
    );
}

function SpacingControls() {
    const [padding, setPadding] = React.useState([16]);
    const [margin, setMargin] = React.useState([0]);
    const [gap, setGap] = React.useState([12]);

    return (
        <div className="space-y-4">
            <SliderControl label="Padding" value={padding} onChange={setPadding} max={64} />
            <SliderControl label="Margin" value={margin} onChange={setMargin} max={64} />
            <SliderControl label="Gap" value={gap} onChange={setGap} max={32} />
        </div>
    );
}

function TypographyControls() {
    const [fontSize, setFontSize] = React.useState([16]);
    const [fontWeight, setFontWeight] = React.useState("500");
    const [lineHeight, setLineHeight] = React.useState([1.5]);

    return (
        <div className="space-y-4">
            <SliderControl label="Font Size" value={fontSize} onChange={setFontSize} max={72} unit="px" />

            <div>
                <label className="text-xs text-[#6B7280] mb-2 block">Weight</label>
                <select
                    value={fontWeight}
                    onChange={(e) => setFontWeight(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg bg-[#111218] border border-white/10 text-sm text-[#E6E6EB] outline-none focus:border-purple-500/50"
                >
                    <option value="400">Regular</option>
                    <option value="500">Medium</option>
                    <option value="600">Semibold</option>
                    <option value="700">Bold</option>
                </select>
            </div>

            <SliderControl
                label="Line Height"
                value={lineHeight}
                onChange={setLineHeight}
                min={1}
                max={2}
                step={0.1}
            />
        </div>
    );
}

function ColorControls() {
    const colors = [
        "#E6E6EB",
        "#9CA3AF",
        "#6366F1",
        "#8B5CF6",
        "#22D3EE",
        "#10B981",
        "#F59E0B",
        "#EF4444",
    ];

    const [selectedColor, setSelectedColor] = React.useState(colors[0]);

    return (
        <div className="space-y-4">
            <div>
                <label className="text-xs text-[#6B7280] mb-2 block">Text Color</label>
                <div className="grid grid-cols-4 gap-2">
                    {colors.map((color) => (
                        <motion.button
                            key={color}
                            onClick={() => setSelectedColor(color)}
                            className={cn(
                                "w-full aspect-square rounded-lg border-2 transition-colors",
                                selectedColor === color
                                    ? "border-white"
                                    : "border-transparent hover:border-white/20"
                            )}
                            style={{ backgroundColor: color }}
                            whileHover={{ scale: 1.05 }}
                            whileTap={{ scale: 0.95 }}
                        />
                    ))}
                </div>
            </div>

            <div>
                <label className="text-xs text-[#6B7280] mb-2 block">Custom</label>
                <div className="flex gap-2">
                    <input
                        type="color"
                        value={selectedColor}
                        onChange={(e) => setSelectedColor(e.target.value)}
                        className="w-10 h-10 rounded-lg border border-white/10 bg-transparent cursor-pointer"
                    />
                    <input
                        type="text"
                        value={selectedColor}
                        onChange={(e) => setSelectedColor(e.target.value)}
                        className="flex-1 px-3 py-2 rounded-lg bg-[#111218] border border-white/10 text-sm text-[#E6E6EB] font-mono outline-none focus:border-purple-500/50"
                    />
                </div>
            </div>
        </div>
    );
}

function SliderControl({
    label,
    value,
    onChange,
    min = 0,
    max = 100,
    step = 1,
    unit = "",
}: {
    label: string;
    value: number[];
    onChange: (value: number[]) => void;
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
}) {
    return (
        <div>
            <div className="flex items-center justify-between mb-2">
                <label className="text-xs text-[#6B7280]">{label}</label>
                <span className="text-xs text-[#E6E6EB] font-mono">
                    {value[0]}{unit}
                </span>
            </div>
            <Slider.Root
                value={value}
                onValueChange={onChange}
                min={min}
                max={max}
                step={step}
                className="relative flex items-center w-full h-5 select-none touch-none"
            >
                <Slider.Track className="relative grow h-1 rounded-full bg-white/10">
                    <Slider.Range className="absolute h-full rounded-full bg-gradient-to-r from-purple-500 to-cyan-500" />
                </Slider.Track>
                <Slider.Thumb className="block w-4 h-4 rounded-full bg-white shadow-lg border-2 border-purple-500 hover:bg-purple-100 focus:outline-none focus:ring-2 focus:ring-purple-500/50 transition-colors cursor-grab active:cursor-grabbing" />
            </Slider.Root>
        </div>
    );
}
