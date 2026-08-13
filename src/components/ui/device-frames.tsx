import React from "react";
import { cn } from "@/lib/utils";

// --- Icons ---

const WifiIcon = ({ className }: { className?: string }) => (
  <svg width="18" height="14" viewBox="0 0 18 14" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <path fillRule="evenodd" clipRule="evenodd" d="M9.01168 2.65934C11.9687 2.65934 14.6599 3.5937 16.8906 5.17188L17.7656 3.93516C15.2661 2.16641 12.2505 1.13984 9.01168 1.13984C5.77289 1.13984 2.75727 2.16641 0.257812 3.93516L1.13281 5.17188C3.36348 3.5937 6.05465 2.65934 9.01168 2.65934ZM9.01172 6.30816C10.983 6.30816 12.7772 7.02641 14.1867 8.21625L15.0617 6.98031C13.3961 5.57422 11.2758 4.78867 9.01172 4.78867C6.74765 4.78867 4.62734 5.57422 2.96172 6.98031L3.83672 8.21625C5.24625 7.02641 7.04047 6.30816 9.01172 6.30816ZM9.01174 9.95703C9.99737 9.95703 10.8945 10.3162 11.5992 10.9109L9.01174 14.5684L6.42424 10.9109C7.129 10.3162 8.02611 9.95703 9.01174 9.95703Z" fill="currentColor"/>
  </svg>
);

const SignalIcon = ({ className }: { className?: string }) => (
  <svg width="19" height="12" viewBox="0 0 19 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="1.5" y="6.5" width="3" height="5.5" rx="1" fill="currentColor" />
    <rect x="6" y="4" width="3" height="8" rx="1" fill="currentColor" />
    <rect x="10.5" y="1.5" width="3" height="10.5" rx="1" fill="currentColor" />
    <rect x="15" width="3" height="12" rx="1" fillOpacity="0.3" fill="currentColor" />
  </svg>
);

const BatteryIcon = ({ className }: { className?: string }) => (
  <svg width="25" height="12" viewBox="0 0 25 12" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
    <rect x="0.5" y="0.5" width="22" height="11" rx="2.5" stroke="currentColor" strokeOpacity="0.35"/>
    <rect x="2" y="2" width="19" height="8" rx="1.5" fill="currentColor" />
    <path d="M24 4C24.5523 4 25 4.44772 25 5V7C25 7.55228 24.5523 8 24 8V4Z" fill="currentColor" fillOpacity="0.35"/>
  </svg>
);

// --- Components ---

interface DeviceFrameProps {
  children?: React.ReactNode;
  className?: string;
  width?: number | string;
  height?: number | string;
}

export const IPhone15ProFrame = ({ children, className }: DeviceFrameProps) => {
  // Logic Resolution: 393 x 852
  // We add double the bezel to the outer container so the inner content area is exactly 393x852
  const bezel = 12;
  const width = 393 + (bezel * 2); 
  const height = 852 + (bezel * 2);
  
  // Realism consts
  const cornerRadius = 54;
  const screenRadius = 44; // Matches the bezel curve
  
  const currentTime = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });

  return (
    <div 
      className={cn(
        "relative box-content bg-[#454545] shadow-[0_0_0_2px_#2a2a2a,0_20px_40px_-12px_rgba(0,0,0,0.5)] select-none",
        className
      )}
      style={{
        width: width,
        height: height,
        borderRadius: cornerRadius,
        padding: 4, // Frame thickness
      }}
    >
        {/* Physical Buttons */}
        {/* Silent Switch */}
        <div className="absolute top-[110px] -left-[6px] w-[3px] h-[26px] bg-[#3a3a3a] rounded-l-sm" />
        {/* Volume Up */}
        <div className="absolute top-[170px] -left-[6px] w-[3px] h-[50px] bg-[#3a3a3a] rounded-l-sm" />
        {/* Volume Down */}
        <div className="absolute top-[235px] -left-[6px] w-[3px] h-[50px] bg-[#3a3a3a] rounded-l-sm" />
        {/* Power */}
        <div className="absolute top-[190px] -right-[6px] w-[3px] h-[80px] bg-[#3a3a3a] rounded-r-sm" />

        {/* Inner Bezel (Black Border) */}
        <div 
            className="relative w-full h-full bg-black overflow-hidden"
            style={{ borderRadius: 50, border: `${bezel}px solid black` }}
        >
            {/* Dynamic Island Area */}
            <div className="absolute top-0 left-0 right-0 h-[54px] z-50 pointer-events-none text-white select-none flex justify-between items-start px-8 pt-[14px] text-[15px] font-semibold tracking-wide font-sans">
                 {/* Left: Time */}
                <div className="w-[54px] flex justify-center pl-2">
                    {currentTime}
                </div>

                {/* Center: Dynamic Island */}
                <div className="absolute top-[11px] left-1/2 -translate-x-1/2 w-[124px] h-[36px] bg-black rounded-[20px] flex items-center justify-end px-3 gap-2 z-50">
                     {/* Hardware camera lens reflection */}
                     <div className="w-3 h-3 rounded-full bg-[#111] ring-1 ring-[#ffffff10] relative overflow-hidden">
                        <div className="absolute inset-0 bg-gradient-to-tr from-transparent to-blue-500/20" />
                     </div>
                     <div className="w-1.5 h-1.5 rounded-full bg-[#111]/80" />
                </div>

                {/* Right: Icons */}
                <div className="flex items-center gap-1.5 pr-1">
                    <SignalIcon className="h-3 w-auto" />
                    <WifiIcon className="h-3 w-auto" />
                    <BatteryIcon className="h-3 w-auto" />
                </div>
            </div>

            {/* Screen Content */}
            <div 
                className="w-full h-full bg-white relative overflow-hidden"
                style={{ borderRadius: screenRadius - 4 }} // Slight adjustment
            >
                {/* Status Bar Background (Simulate Top Safe Area) */}
                {/* We don't block content, but existing apps might need padding. 
                    If we want realism, the status bar usually floats. 
                    We already rendered the status bar text above (z-50).
                    This div is the Viewport. */}
                {children}

                {/* Bottom Home Indicator */}
                <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-[130px] h-[5px] bg-black/80 rounded-full z-50 pointer-events-none mix-blend-difference invert" />
            </div>
        </div>
    </div>
  );
};

// --- iPad Pro 11-inch ---

export const IPadPro11Frame = ({ children, className }: DeviceFrameProps) => {
    // Logic Resolution: 834 x 1194
    // We add double the bezel to the outer container so the inner content area is exactly 834x1194
    const bezel = 20; 
    const width = 834 + (bezel * 2); 
    const height = 1194 + (bezel * 2);
    
    // Realism consts
    const cornerRadius = 32; 
    
    // Date/Time for iPad
    const now = new Date();
    const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: false });
    const date = now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return (
    <div 
      className={cn(
        "relative box-content bg-[#4a4a4a] shadow-[0_0_0_2px_#333,0_30px_60px_-12px_rgba(0,0,0,0.5)] select-none",
        className
      )}
      style={{
        width: width,
        height: height,
        borderRadius: cornerRadius,
        padding: 4,
      }}
    >
        {/* Buttons */}
        <div className="absolute -top-[3px] right-[60px] w-[50px] h-[3px] bg-[#333] rounded-t-sm" /> {/* Top button */}
        <div className="absolute top-[80px] -right-[3px] w-[3px] h-[50px] bg-[#333] rounded-r-sm" /> {/* Vol Up */}
        <div className="absolute top-[140px] -right-[3px] w-[3px] h-[50px] bg-[#333] rounded-r-sm" /> {/* Vol Down */}

        {/* Inner Bezel */}
        <div 
            className="relative w-full h-full bg-black overflow-hidden"
            style={{ borderRadius: 28, border: `${bezel}px solid black` }}
        >
             {/* Status Bar */}
             <div className="absolute top-0 left-0 right-0 h-[28px] z-50 pointer-events-none text-white flex justify-between items-center px-4 text-[13px] font-medium tracking-wide">
                {/* Left: Date Time */}
                <div className="flex items-center gap-2 opacity-90">
                    <span>{time}</span>
                    <span className="opacity-60">{date}</span>
                </div>

                {/* Right: Icons */}
                <div className="flex items-center gap-1.5 opacity-90">
                    <WifiIcon className="h-3 w-auto" />
                    <span className="text-[10px] font-bold">100%</span>
                    <BatteryIcon className="h-3 w-auto" />
                </div>
            </div>

            {/* Screen Content */}
            <div className="w-full h-full bg-white relative overflow-hidden rounded-[12px]">
                {children}
                 {/* Bottom Home Indicator */}
                 <div className="absolute bottom-2 left-1/2 -translate-x-1/2 w-[30%] h-[4px] bg-black/30 rounded-full z-50 pointer-events-none mix-blend-difference invert backdrop-blur-md" />
            </div>
        </div>
    </div>
  );
};
