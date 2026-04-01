import React from 'react';

const ContentRowSkeleton: React.FC = () => {
  return (
    <div className="mb-8 animate-pulse">
      {/* Title skeleton */}
      <div className="h-6 w-48 bg-gray-700 rounded mb-4"></div>
      
      {/* Content cards skeleton */}
      <div className="flex gap-4 overflow-hidden">
        {[1, 2, 3, 4, 5].map((item) => (
          <div key={item} className="flex-shrink-0">
            {/* Card skeleton */}
            <div className="w-[200px] h-[300px] bg-gray-700 rounded-lg mb-2"></div>
            {/* Title skeleton */}
            <div className="h-4 bg-gray-700 rounded w-3/4 mb-2"></div>
            {/* Subtitle skeleton */}
            <div className="h-3 bg-gray-700 rounded w-1/2"></div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ContentRowSkeleton;
