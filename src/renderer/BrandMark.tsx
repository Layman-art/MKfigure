import iconUrl from '../../resources/icon.png';

export default function BrandMark({ className = '' }: { className?: string }) {
  return <img className={className} src={iconUrl} alt="" aria-hidden="true" draggable={false} />;
}
