/**
 * @avo/ui — the web component library shared by the merchant dashboard and the
 * owner console.
 *
 * Consumers import `@avo/tokens/css` first, then `@avo/ui/css`. Nothing in here
 * carries a colour literal; every value resolves through an `--avo-*` custom
 * property so a white-label build changes five variables and nothing else.
 */

export { Button, type ButtonProps, type ButtonVariant } from './Button.js';
export { Card, type CardProps } from './Card.js';
export { Chip, type ChipProps } from './Chip.js';
export { InfoBanner, type InfoBannerProps } from './InfoBanner.js';
export { InlineError, type InlineErrorProps } from './InlineError.js';
export { Money, type MoneyProps } from './Money.js';
export { Pill, type PillProps, type PillTone } from './Pill.js';
export { Segmented, type SegmentedOption, type SegmentedProps } from './Segmented.js';
export { Select, type SelectOption, type SelectProps } from './Select.js';
export { Stepper, type StepperProps } from './Stepper.js';
export { Skeleton, type SkeletonProps } from './Skeleton.js';
export { StatCard, type StatCardProps } from './StatCard.js';
export { TextField, type TextFieldProps } from './TextField.js';
export { Toggle, type ToggleProps } from './Toggle.js';
export {
  EmptyState,
  ErrorState,
  StaleBanner,
  type EmptyStateProps,
  type ErrorStateProps,
  type StaleBannerProps,
} from './StateBlocks.js';
