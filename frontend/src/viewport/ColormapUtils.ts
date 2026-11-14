import {
    getColormapIndex as getUnifiedColormapIndex,
    evaluateColormapRGB,
    buildColormapCSSGradient
} from '../contour-style.js';

export function getColormapIndex(name?: string): number {
    return getUnifiedColormapIndex(name);
}

export function sampleColormapRGB(v: number, cmapName: string): [number, number, number] {
    return evaluateColormapRGB(v, cmapName);
}

export function getColormapCssGradient(
    cmapId: string,
    direction: 'to top' | 'to right' = 'to top',
    contourLevels: number = 0,
    smoothContours: boolean = contourLevels <= 1
): string {
    return buildColormapCSSGradient(cmapId, direction, contourLevels, smoothContours);
}
