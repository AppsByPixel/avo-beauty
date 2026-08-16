export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
}

/**
 * interaction-spec.md §4: skeletons match the real layout's shape. Money fields
 * skeleton as a bar — never render `0.000` before data arrives.
 */
export function Skeleton({ width = '100%', height = 14, radius }: SkeletonProps) {
  return (
    <span
      className="avo-skeleton"
      aria-hidden="true"
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        ...(radius === undefined
          ? {}
          : { borderRadius: typeof radius === 'number' ? `${radius}px` : radius }),
      }}
    />
  );
}
