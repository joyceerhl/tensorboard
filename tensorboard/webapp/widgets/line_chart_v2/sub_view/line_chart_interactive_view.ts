/* Copyright 2020 The TensorFlow Authors. All Rights Reserved.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
==============================================================================*/

import {
  CdkConnectedOverlay,
  ConnectedPosition,
  Overlay,
  RepositionScrollStrategy,
} from '@angular/cdk/overlay';
import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  ElementRef,
  EventEmitter,
  HostBinding,
  Input,
  OnChanges,
  OnDestroy,
  Output,
  TemplateRef,
  ViewChild,
} from '@angular/core';
import {fromEvent, of, Subject, timer} from 'rxjs';
import {filter, map, switchMap, takeUntil, tap} from 'rxjs/operators';

import {
  DataSeries,
  DataSeriesMetadataMap,
  Dimension,
  Extent,
  Rect,
  Scale,
} from '../lib/public_types';
import {getScaleRangeFromDomDim} from './chart_view_utils';
import {
  findClosestIndex,
  proposeViewExtentOnZoom,
} from './line_chart_interactive_utils';

export interface TooltipDatum {
  id: string;
  metadata: DataSeriesMetadataMap[string];
  indClosest: number | null;
  point: {x: number; y: number} | null;
}

enum InteractionState {
  NONE,
  DRAG_ZOOMING,
  SCROLL_ZOOMING,
  PANNING,
}

const SCROLL_ZOOM_SPEED_FACTOR = 0.01;

export function scrollStrategyFactory(
  overlay: Overlay
): RepositionScrollStrategy {
  return overlay.scrollStrategies.reposition();
}

export interface TooltipTemplateContext {
  data: TooltipDatum;
}

export type TooltipTemplate = TemplateRef<TooltipTemplateContext>;

@Component({
  selector: 'line-chart-interactive-view',
  templateUrl: './line_chart_interactive_view.ng.html',
  styleUrls: ['./line_chart_interactive_view.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: RepositionScrollStrategy,
      useFactory: scrollStrategyFactory,
      deps: [Overlay],
    },
  ],
})
export class LineChartInteractiveViewComponent implements OnChanges, OnDestroy {
  @ViewChild('dots', {static: true, read: ElementRef})
  dotsContainer!: ElementRef<SVGElement>;

  @ViewChild(CdkConnectedOverlay)
  overlay!: CdkConnectedOverlay;

  @Input()
  seriesData!: DataSeries[];

  @Input()
  seriesMetadataMap!: DataSeriesMetadataMap;

  @Input()
  viewExtent!: Extent;

  @Input()
  xScale!: Scale;

  @Input()
  yScale!: Scale;

  @Input()
  domDim!: Dimension;

  @Input()
  tooltipOriginEl!: ElementRef;

  @Input()
  tooltipTemplate?: TooltipTemplate;

  @Output()
  onViewExtentChange = new EventEmitter<Extent>();

  @Output()
  onViewExtentReset = new EventEmitter<void>();

  readonly InteractionState = InteractionState;

  state: InteractionState = InteractionState.NONE;

  // Gray box that shows when user drags with mouse down
  zoomBoxInUiCoordinate: Rect = {x: 0, width: 0, height: 0, y: 0};

  readonly tooltipPositions: ConnectedPosition[] = [
    // Prefer align at bottom edge of the line chart
    {
      offsetY: 5,
      originX: 'start',
      overlayX: 'start',
      originY: 'bottom',
      overlayY: 'top',
    },
    // Then top
    {
      offsetY: 5,
      originX: 'start',
      overlayX: 'start',
      originY: 'top',
      overlayY: 'bottom',
    },
    // then right
    {
      offsetX: 5,
      originX: 'end',
      overlayX: 'start',
      originY: 'top',
      overlayY: 'top',
    },
  ];

  cursorXLocation: number | null = null;
  cursoredData: TooltipDatum[] = [];
  tooltipDislayAttached: boolean = false;

  @HostBinding('class.show-zoom-instruction')
  showZoomInstruction: boolean = false;

  private dragStartCoord: {x: number; y: number} | null = null;
  private isCursorInside = false;
  private readonly ngUnsubscribe = new Subject();

  constructor(
    private readonly changeDetector: ChangeDetectorRef,
    readonly scrollStrategy: RepositionScrollStrategy
  ) {}

  ngAfterViewInit() {
    fromEvent<MouseEvent>(this.dotsContainer.nativeElement, 'dblclick', {
      passive: false,
    })
      .pipe(takeUntil(this.ngUnsubscribe))
      .subscribe((event) => {
        // Prevent double click from selecting text.
        event.preventDefault();
        this.onViewExtentReset.emit();
        this.state = InteractionState.NONE;
        this.changeDetector.markForCheck();
      });

    fromEvent<MouseEvent>(this.dotsContainer.nativeElement, 'mousedown', {
      passive: false,
    })
      .pipe(takeUntil(this.ngUnsubscribe))
      .subscribe((event) => {
        event.preventDefault();
        this.state = event.shiftKey
          ? InteractionState.PANNING
          : InteractionState.DRAG_ZOOMING;
        this.dragStartCoord = {x: event.offsetX, y: event.offsetY};

        if (this.state === InteractionState.DRAG_ZOOMING) {
          this.zoomBoxInUiCoordinate = {
            x: event.offsetX,
            width: 0,
            y: event.offsetY,
            height: 0,
          };
        }

        this.changeDetector.markForCheck();
      });

    fromEvent<MouseEvent>(this.dotsContainer.nativeElement, 'mouseup', {
      passive: true,
    })
      .pipe(takeUntil(this.ngUnsubscribe))
      .subscribe(() => {
        this.dragStartCoord = null;

        const zoomBox = this.zoomBoxInUiCoordinate;
        if (
          this.state === InteractionState.DRAG_ZOOMING &&
          zoomBox.width > 0 &&
          zoomBox.height > 0
        ) {
          const xMin = this.getDataX(zoomBox.x);
          const xMax = this.getDataX(zoomBox.x + zoomBox.width);
          const yMin = this.getDataY(zoomBox.y + zoomBox.height);
          const yMax = this.getDataY(zoomBox.y);

          this.onViewExtentChange.emit({
            x: [xMin, xMax],
            y: [yMin, yMax],
          });
        }
        if (this.state !== InteractionState.NONE) {
          this.state = InteractionState.NONE;
          this.changeDetector.markForCheck();
        }
      });

    fromEvent<MouseEvent>(this.dotsContainer.nativeElement, 'mouseenter', {
      passive: true,
    })
      .pipe(takeUntil(this.ngUnsubscribe))
      .subscribe((event) => {
        this.isCursorInside = true;
        this.updateTooltip(event);
        this.changeDetector.markForCheck();
      });

    fromEvent<MouseEvent>(this.dotsContainer.nativeElement, 'mouseleave', {
      passive: true,
    })
      .pipe(takeUntil(this.ngUnsubscribe))
      .subscribe((event) => {
        this.dragStartCoord = null;
        this.isCursorInside = false;
        this.updateTooltip(event);
        this.state = InteractionState.NONE;
        this.changeDetector.markForCheck();
      });

    fromEvent<MouseEvent>(this.dotsContainer.nativeElement, 'mousemove', {
      passive: true,
    })
      .pipe(takeUntil(this.ngUnsubscribe))
      .subscribe((event) => {
        switch (this.state) {
          case InteractionState.SCROLL_ZOOMING: {
            this.state = InteractionState.NONE;
            this.updateTooltip(event);
            this.changeDetector.markForCheck();
            break;
          }
          case InteractionState.NONE:
            this.updateTooltip(event);
            this.changeDetector.markForCheck();
            break;
          case InteractionState.PANNING: {
            const deltaX = -event.movementX;
            const deltaY = -event.movementY;
            const {width: domWidth, height: domHeight} = this.domDim;
            const xMin = this.getDataX(deltaX);
            const xMax = this.getDataX(domWidth + deltaX);
            const yMin = this.getDataY(domHeight + deltaY);
            const yMax = this.getDataY(deltaY);
            this.onViewExtentChange.emit({
              x: [xMin, xMax],
              y: [yMin, yMax],
            });
            break;
          }
          case InteractionState.DRAG_ZOOMING:
            {
              if (!this.dragStartCoord) {
                break;
              }
              const xs = [this.dragStartCoord.x, event.offsetX];
              const ys = [this.dragStartCoord.y, event.offsetY];
              this.zoomBoxInUiCoordinate = {
                x: Math.min(...xs),
                width: Math.max(...xs) - Math.min(...xs),
                y: Math.min(...ys),
                height: Math.max(...ys) - Math.min(...ys),
              };
            }
            this.changeDetector.markForCheck();
            break;
        }
      });

    fromEvent<WheelEvent>(this.dotsContainer.nativeElement, 'wheel', {
      passive: false,
    })
      .pipe(
        takeUntil(this.ngUnsubscribe),
        switchMap((event: WheelEvent) => {
          const shouldZoom = !event.ctrlKey && !event.shiftKey && event.altKey;
          this.showZoomInstruction = !shouldZoom;
          this.changeDetector.markForCheck();

          if (shouldZoom) {
            return of(event);
          }
          return timer(3000).pipe(
            tap(() => {
              this.showZoomInstruction = false;
              this.changeDetector.markForCheck();
            }),
            map(() => null)
          );
        }),
        filter((eventOrNull) => Boolean(eventOrNull))
      )
      .subscribe((eventOrNull) => {
        const event = eventOrNull!;
        event.preventDefault();

        this.onViewExtentChange.emit(
          proposeViewExtentOnZoom(
            event,
            this.viewExtent,
            this.domDim,
            SCROLL_ZOOM_SPEED_FACTOR
          )
        );

        if (this.state !== InteractionState.SCROLL_ZOOMING) {
          this.state = InteractionState.SCROLL_ZOOMING;
          this.changeDetector.markForCheck();
        }
      });
  }

  ngOnChanges() {
    this.updateCursoredDataAndTooltipVisibility();
  }

  ngOnDestroy() {
    this.ngUnsubscribe.next();
    this.ngUnsubscribe.complete();
  }

  trackBySeriesName(index: number, datum: TooltipDatum) {
    return datum.id;
  }

  getDomX(uiCoord: number): number {
    return this.xScale.forward(
      this.viewExtent.x,
      getScaleRangeFromDomDim(this.domDim, 'x'),
      uiCoord
    );
  }

  private getDataX(uiCoord: number): number {
    return this.xScale.reverse(
      this.viewExtent.x,
      getScaleRangeFromDomDim(this.domDim, 'x'),
      uiCoord
    );
  }

  getDomY(uiCoord: number): number {
    return this.yScale.forward(
      this.viewExtent.y,
      getScaleRangeFromDomDim(this.domDim, 'y'),
      uiCoord
    );
  }

  private getDataY(uiCoord: number): number {
    return this.yScale.reverse(
      this.viewExtent.y,
      getScaleRangeFromDomDim(this.domDim, 'y'),
      uiCoord
    );
  }

  private updateTooltip(event: MouseEvent) {
    this.cursorXLocation = this.getDataX(event.offsetX);
    this.updateCursoredDataAndTooltipVisibility();
  }

  onTooltipDisplayDetached() {
    this.tooltipDislayAttached = false;
  }

  private updateCursoredDataAndTooltipVisibility() {
    if (this.cursorXLocation === null) return;
    const cursorXLocation = this.cursorXLocation;

    this.cursoredData = this.seriesData
      .map((seriesData) => {
        return {
          seriesData,
          metadata: this.seriesMetadataMap[seriesData.id],
        };
      })
      .filter(({metadata}) => {
        return metadata && metadata.visible && !Boolean(metadata.aux);
      })
      .map(({seriesData, metadata}) => {
        const index = findClosestIndex(seriesData.points, cursorXLocation);
        return {
          id: seriesData.id,
          indClosest: index,
          point: index !== null ? seriesData.points[index] : null,
          metadata,
        };
      })
      .filter(({indClosest}) => indClosest !== null);
    this.tooltipDislayAttached =
      this.isCursorInside && Boolean(this.cursoredData.length);
  }
}
