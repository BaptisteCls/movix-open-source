import React, { useEffect, useState } from 'react';

interface SnowflakeProps {
  enabled: boolean;
}

const Snowflakes: React.FC<SnowflakeProps> = ({ enabled }) => {
  const [mousePosition, setMousePosition] = useState({ x: 0, y: 0 });
  const [snowflakes, setSnowflakes] = useState<Array<{ id: number; x: number; y: number; size: number }>>([]);

  useEffect(() => {
    if (!enabled) {
      setSnowflakes([]);
      return;
    }

    const handleMouseMove = (e: MouseEvent) => {
      setMousePosition({ x: e.clientX, y: e.clientY });
    };

    window.addEventListener('mousemove', handleMouseMove);

    const createSnowflake = () => {
      const id = Date.now();
      const size = Math.random() * 10 + 5;
      setSnowflakes(prev => [...prev.slice(-50), { 
        id,
        x: mousePosition.x,
        y: mousePosition.y,
        size
      }]);
    };

    const interval = setInterval(createSnowflake, 50);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      clearInterval(interval);
    };
  }, [enabled, mousePosition]);

  if (!enabled) return null;

  return (
    <div className="fixed inset-0 pointer-events-none">
      {snowflakes.map((snowflake) => (
        <div
          key={snowflake.id}
          className="absolute text-white animate-fall"
          style={{
            left: `${snowflake.x}px`,
            top: `${snowflake.y}px`,
            fontSize: `${snowflake.size}px`,
            transition: 'all 1s linear',
            opacity: Math.random() * 0.5 + 0.5,
          }}
        >
          ❄
        </div>
      ))}
    </div>
  );
};

export default Snowflakes;
