import { useEffect } from 'react';
import { useSnow } from '../context/SnowContext';

declare global {
  interface Window {
    particlesJS: any;
  }
}

const Snow = () => {
  const { isSnowEnabled } = useSnow();

  useEffect(() => {
    if (!isSnowEnabled) return;
    
    const script = document.createElement('script');
    script.src = 'https://cdn.jsdelivr.net/particles.js/2.0.0/particles.min.js';
    script.onload = function() {
      window.particlesJS("snow", {
        "particles": {
          "number": {
            "value": 300,
            "density": {
              "enable": true,
              "value_area": 800
            }
          },
          "color": {
            "value": "#ffffff"
          },
          "shape": {
            "type": ["circle", "star"],
            "stroke": {
              "width": 0,
              "color": "#ffffff"
            }
          },
          "opacity": {
            "value": 0.7,
            "random": true,
            "anim": {
              "enable": true,
              "speed": 0.3,
              "opacity_min": 0.2,
              "sync": false
            }
          },
          "size": {
            "value": 4,
            "random": true,
            "anim": {
              "enable": true,
              "speed": 2,
              "size_min": 1,
              "sync": false
            }
          },
          "line_linked": {
            "enable": false
          },
          "move": {
            "enable": true,
            "speed": 3,
            "direction": "bottom",
            "random": true,
            "straight": false,
            "out_mode": "out",
            "bounce": false,
            "attract": {
              "enable": true,
              "rotateX": 600,
              "rotateY": 1200
            }
          }
        },
        "interactivity": {
          "detect_on": "canvas",
          "events": {
            "onhover": {
              "enable": true,
              "mode": "bubble"
            },
            "onclick": {
              "enable": true,
              "mode": "repulse"
            },
            "resize": true
          },
          "modes": {
            "bubble": {
              "distance": 150,
              "size": 6,
              "duration": 0.3,
              "opacity": 1,
              "speed": 3
            },
            "repulse": {
              "distance": 150,
              "duration": 0.3
            }
          }
        },
        "retina_detect": true,
        "background": {
          "color": "transparent",
          "image": "",
          "position": "50% 50%",
          "repeat": "no-repeat",
          "size": "cover"
        }
      });
    }
    document.head.append(script);

    return () => {
      const scripts = document.getElementsByTagName('script');
      for (let i = 0; i < scripts.length; i++) {
        if (scripts[i].src.includes('particles.min.js')) {
          scripts[i].remove();
        }
      }
      const canvas = document.querySelector('canvas');
      if (canvas) {
        canvas.remove();
      }
    }
  }, [isSnowEnabled]);

  return <div id="snow" />;
}

export default Snow;
