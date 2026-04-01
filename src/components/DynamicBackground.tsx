import React, { useEffect, useRef } from 'react';

interface DynamicBackgroundProps {
  color?: 'red' | 'blue' | 'purple';
  intensity?: 'low' | 'medium' | 'high';
  speed?: 'slow' | 'medium' | 'fast';
  particleCount?: number;
}

interface Particle {
  id: number;
  x: number;
  y: number;
  size: number;
  speed: number;
  opacity: number;
  direction: { x: number; y: number };
}

const DynamicBackground: React.FC<DynamicBackgroundProps> = ({
  color = 'red',
  intensity = 'medium',
  speed = 'medium',
  particleCount = 50
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationRef = useRef<number>(0);
  const particlesRef = useRef<Particle[]>([]);
  const isRunningRef = useRef(true);
  
  // Get color based on prop
  const getColorValues = () => {
    switch (color) {
      case 'blue':
        return { primary: '37, 99, 235', secondary: '30, 58, 138' };
      case 'purple':
        return { primary: '147, 51, 234', secondary: '88, 28, 135' };
      case 'red':
      default:
        return { primary: '220, 38, 38', secondary: '127, 29, 29' };
    }
  };
  
  // Get intensity value
  const getIntensityValue = () => {
    switch (intensity) {
      case 'low': return 0.2;
      case 'high': return 0.5;
      case 'medium':
      default: return 0.35;
    }
  };
  
  // Get speed multiplier
  const getSpeedMultiplier = () => {
    switch (speed) {
      case 'slow': return 0.5;
      case 'fast': return 1.5;
      case 'medium':
      default: return 1;
    }
  };

  // Initialize particles
  useEffect(() => {
    isRunningRef.current = true;
    
    const generateParticles = () => {
      const newParticles: Particle[] = Array.from({ length: particleCount }, (_, i) => ({
        id: i,
        x: Math.random() * 100,
        y: Math.random() * 100,
        size: 1 + Math.random() * 3,
        speed: (0.1 + Math.random() * 0.3) * getSpeedMultiplier(),
        opacity: 0.1 + Math.random() * getIntensityValue(),
        direction: {
          x: (Math.random() - 0.5) * 2,
          y: (Math.random() - 0.5) * 2
        }
      }));
      
      particlesRef.current = newParticles;
    };
    
    generateParticles();
    
    // Resize handler
    const handleResize = () => {
      if (canvasRef.current) {
        canvasRef.current.width = window.innerWidth;
        canvasRef.current.height = window.innerHeight;
      }
    };
    
    window.addEventListener('resize', handleResize);
    handleResize();
    
    // Animation loop
    const animate = () => {
      if (!isRunningRef.current) return;
      
      const canvas = canvasRef.current;
      if (!canvas) return;
      
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      
      // Clear canvas with slight fade effect for trails
      ctx.fillStyle = 'rgba(0, 0, 0, 0.05)';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      
      const colors = getColorValues();
      const intensityValue = getIntensityValue();
      
      // Update and draw particles without using setState
      particlesRef.current.forEach(particle => {
        // Update position directly in the ref
        particle.x = ((particle.x + (particle.speed * particle.direction.x * 0.2)) % 100 + 100) % 100;
        particle.y = ((particle.y + (particle.speed * particle.direction.y * 0.2)) % 100 + 100) % 100;
        
        // Draw particle
        const xPos = (particle.x / 100) * canvas.width;
        const yPos = (particle.y / 100) * canvas.height;
        
        ctx.beginPath();
        ctx.arc(xPos, yPos, particle.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${colors.primary}, ${particle.opacity})`;
        ctx.fill();
        
        // Draw glow
        const glow = ctx.createRadialGradient(
          xPos, yPos, 0,
          xPos, yPos, particle.size * 4
        );
        glow.addColorStop(0, `rgba(${colors.primary}, ${particle.opacity * 0.5})`);
        glow.addColorStop(1, `rgba(${colors.primary}, 0)`);
        
        ctx.beginPath();
        ctx.arc(xPos, yPos, particle.size * 4, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();
      });
      
      // Draw subtle rays occasionally
      if (Math.random() < 0.02) {
        const rayX = Math.random() * canvas.width;
        const rayY = Math.random() * canvas.height;
        const rayLength = 50 + Math.random() * 150;
        const angle = Math.random() * Math.PI * 2;
        
        ctx.beginPath();
        ctx.moveTo(rayX, rayY);
        ctx.lineTo(
          rayX + Math.cos(angle) * rayLength,
          rayY + Math.sin(angle) * rayLength
        );
        const rayGradient = ctx.createLinearGradient(
          rayX, rayY,
          rayX + Math.cos(angle) * rayLength,
          rayY + Math.sin(angle) * rayLength
        );
        rayGradient.addColorStop(0, `rgba(${colors.secondary}, ${intensityValue * 0.4})`);
        rayGradient.addColorStop(1, `rgba(${colors.secondary}, 0)`);
        
        ctx.strokeStyle = rayGradient;
        ctx.lineWidth = 0.5 + Math.random();
        ctx.stroke();
      }
      
      animationRef.current = requestAnimationFrame(animate);
    };
    
    // Start animation
    if (canvasRef.current) {
      animationRef.current = requestAnimationFrame(animate);
    }
    
    // Cleanup function
    return () => {
      isRunningRef.current = false;
      window.removeEventListener('resize', handleResize);
      cancelAnimationFrame(animationRef.current);
    };
  }, [color, intensity, speed, particleCount]);

  return (
    <canvas 
      ref={canvasRef}
      className="fixed inset-0 pointer-events-none z-[-1]"
      style={{ opacity: getIntensityValue() * 2 }}
    />
  );
};

export default DynamicBackground; 