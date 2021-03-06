import { IScheduler } from '../Scheduler';
import { Action } from '../scheduler/Action';
import { Subject } from '../Subject';
import { Operator } from '../Operator';
import { async } from '../scheduler/async';
import { Subscriber } from '../Subscriber';
import { Observable } from '../Observable';
import { Subscription } from '../Subscription';

/**
 * Branch out the source Observable values as a nested Observable periodically
 * in time.
 *
 * <span class="informal">It's like {@link bufferTime}, but emits a nested
 * Observable instead of an array.</span>
 *
 * <img src="./img/windowTime.png" width="100%">
 *
 * Returns an Observable that emits windows of items it collects from the source
 * Observable. The output Observable starts a new window periodically, as
 * determined by the `windowCreationInterval` argument. It emits each window
 * after a fixed timespan, specified by the `windowTimeSpan` argument. When the
 * source Observable completes or encounters an error, the output Observable
 * emits the current window and propagates the notification from the source
 * Observable. If `windowCreationInterval` is not provided, the output
 * Observable starts a new window when the previous window of duration
 * `windowTimeSpan` completes.
 *
 * @example <caption>In every window of 1 second each, emit at most 2 click events</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var result = clicks.windowTime(1000)
 *   .map(win => win.take(2)) // each window has at most 2 emissions
 *   .mergeAll(); // flatten the Observable-of-Observables
 * result.subscribe(x => console.log(x));
 *
 * @example <caption>Every 5 seconds start a window 1 second long, and emit at most 2 click events per window</caption>
 * var clicks = Rx.Observable.fromEvent(document, 'click');
 * var result = clicks.windowTime(1000, 5000)
 *   .map(win => win.take(2)) // each window has at most 2 emissions
 *   .mergeAll(); // flatten the Observable-of-Observables
 * result.subscribe(x => console.log(x));
 *
 * @see {@link window}
 * @see {@link windowCount}
 * @see {@link windowToggle}
 * @see {@link windowWhen}
 * @see {@link bufferTime}
 *
 * @param {number} windowTimeSpan The amount of time to fill each window.
 * @param {number} [windowCreationInterval] The interval at which to start new
 * windows.
 * @param {Scheduler} [scheduler=async] The scheduler on which to schedule the
 * intervals that determine window boundaries.
 * @return {Observable<Observable<T>>} An observable of windows, which in turn
 * are Observables.
 * @method windowTime
 * @owner Observable
 */
export function windowTime<T>(this: Observable<T>, windowTimeSpan: number,
                              windowCreationInterval: number = null,
                              scheduler: IScheduler = async): Observable<Observable<T>> {
  return this.lift(new WindowTimeOperator<T>(windowTimeSpan, windowCreationInterval, scheduler));
}

class WindowTimeOperator<T> implements Operator<T, Observable<T>> {

  constructor(private windowTimeSpan: number,
              private windowCreationInterval: number,
              private scheduler: IScheduler) {
  }

  call(subscriber: Subscriber<Observable<T>>, source: any): any {
    return source.subscribe(new WindowTimeSubscriber(
      subscriber, this.windowTimeSpan, this.windowCreationInterval, this.scheduler
    ));
  }
}

interface CreationState<T> {
  windowTimeSpan: number;
  windowCreationInterval: number;
  subscriber: WindowTimeSubscriber<T>;
  scheduler: IScheduler;
}

interface TimeSpanOnlyState<T> {
    window: Subject<T>;
    windowTimeSpan: number;
    subscriber: WindowTimeSubscriber<T>;
  }

interface CloseWindowContext<T> {
  action: Action<CreationState<T>>;
  subscription: Subscription;
}

interface CloseState<T> {
  subscriber: WindowTimeSubscriber<T>;
  window: Subject<T>;
  context: CloseWindowContext<T>;
}

/**
 * We need this JSDoc comment for affecting ESDoc.
 * @ignore
 * @extends {Ignored}
 */
class WindowTimeSubscriber<T> extends Subscriber<T> {
  private windows: Array<Subject<T>> = [];

  constructor(protected destination: Subscriber<Observable<T>>,
              private windowTimeSpan: number,
              private windowCreationInterval: number,
              private scheduler: IScheduler) {
    super(destination);
    if (windowCreationInterval !== null && windowCreationInterval >= 0) {
      let window = this.openWindow();
      const closeState: CloseState<T> = { subscriber: this, window, context: <any>null };
      const creationState: CreationState<T> = { windowTimeSpan, windowCreationInterval, subscriber: this, scheduler };
      this.add(scheduler.schedule(dispatchWindowClose, windowTimeSpan, closeState));
      this.add(scheduler.schedule(dispatchWindowCreation, windowCreationInterval, creationState));
    } else {
      let window = this.openWindow();
      const timeSpanOnlyState: TimeSpanOnlyState<T> = { subscriber: this, window, windowTimeSpan };
      this.add(scheduler.schedule(dispatchWindowTimeSpanOnly, windowTimeSpan, timeSpanOnlyState));
    }
  }

  protected _next(value: T): void {
    const windows = this.windows;
    const len = windows.length;
    for (let i = 0; i < len; i++) {
      const window = windows[i];
      if (!window.closed) {
        window.next(value);
      }
    }
  }

  protected _error(err: any): void {
    const windows = this.windows;
    while (windows.length > 0) {
      windows.shift().error(err);
    }
    this.destination.error(err);
  }

  protected _complete(): void {
    const windows = this.windows;
    while (windows.length > 0) {
      const window = windows.shift();
      if (!window.closed) {
        window.complete();
      }
    }
    this.destination.complete();
  }

  public openWindow(): Subject<T> {
    const window = new Subject<T>();
    this.windows.push(window);
    const destination = this.destination;
    destination.next(window);
    return window;
  }

  public closeWindow(window: Subject<T>): void {
    window.complete();
    const windows = this.windows;
    windows.splice(windows.indexOf(window), 1);
  }
}

function dispatchWindowTimeSpanOnly<T>(this: Action<TimeSpanOnlyState<T>>, state: TimeSpanOnlyState<T>): void {
  const { subscriber, windowTimeSpan, window } = state;
  if (window) {
    window.complete();
  }
  state.window = subscriber.openWindow();
  this.schedule(state, windowTimeSpan);
}

function dispatchWindowCreation<T>(this: Action<CreationState<T>>, state: CreationState<T>): void {
  const { windowTimeSpan, subscriber, scheduler, windowCreationInterval } = state;
  const window = subscriber.openWindow();
  const action = this;
  let context: CloseWindowContext<T> = { action, subscription: <any>null };
  const timeSpanState: CloseState<T> = { subscriber, window, context };
  context.subscription = scheduler.schedule(dispatchWindowClose, windowTimeSpan, timeSpanState);
  action.add(context.subscription);
  action.schedule(state, windowCreationInterval);
}

function dispatchWindowClose<T>(state: CloseState<T>): void {
  const { subscriber, window, context } = state;
  if (context && context.action && context.subscription) {
    context.action.remove(context.subscription);
  }
  subscriber.closeWindow(window);
}
