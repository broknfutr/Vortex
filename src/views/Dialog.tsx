import { ILink, triggerDialogLink } from '../actions';
import { closeDialog } from '../actions/notifications';
import Collapse from '../controls/Collapse';
import Icon from '../controls/Icon';
import Webview from '../controls/Webview';
import {
  DialogType, ICheckbox, IDialog,
  IDialogContent, IInput, DisabledActions
} from '../types/IDialog';
import { IState } from '../types/IState';
import bbcode from '../util/bbcode';
import { ComponentEx, connect, translate } from '../util/ComponentEx';

import { remote } from 'electron';
import * as I18next from 'i18next';
import update from 'immutability-helper';
import * as React from 'react';
import {
  Button, Checkbox, ControlLabel, FormControl, FormGroup,
  Modal, Radio,
} from 'react-bootstrap';
import * as ReactDOM from 'react-dom';
import * as Redux from 'redux';
import { ThunkDispatch } from 'redux-thunk';

const nop = () => undefined;

interface IActionProps {
  t: (input: string) => string;
  onDismiss: (action: string) => void;
  action: string;
  isDefault: boolean;
  isDisabled: boolean;
}

class Action extends React.Component<IActionProps, {}> {
  public render(): JSX.Element {
    const { t, action, isDefault, isDisabled } = this.props;
    return (
      <Button
        id='close'
        onClick={this.dismiss}
        bsStyle={isDefault ? 'primary' : undefined}
        ref={isDefault ? this.focus : undefined}
        disabled={isDisabled}
      >
        {t(action)}
      </Button>
    );
  }

  private focus = ref => {
    if (ref !== null) {
      (ReactDOM.findDOMNode(ref) as HTMLElement).focus();
    }
  }

  private dismiss = () => {
    const { onDismiss, action } = this.props;
    onDismiss(action);
  }
}

interface IDialogConnectedProps {
  dialogs: IDialog[];
}

interface IDialogActionProps {
  onDismiss: (id: string, action: string, input: IDialogContent) => void;
}

interface IComponentState {
  currentDialogId: string;
  dialogState: IDialogContent;
  disabledActions: DisabledActions;
}

type IProps = IDialogConnectedProps & IDialogActionProps;

class Dialog extends ComponentEx<IProps, IComponentState> {
  constructor(props: IProps) {
    super(props);

    this.state = {
      currentDialogId: undefined,
      dialogState: undefined,
      disabledActions: [],
    };
  }

  public componentWillReceiveProps(newProps: IProps) {
    if ((newProps.dialogs.length > 0) &&
      (newProps.dialogs[0].id !== this.state.currentDialogId)) {
      let newState = update(this.state, {
        currentDialogId: { $set: newProps.dialogs[0].id },
        dialogState: { $set: newProps.dialogs[0].content },
      });

      const newMap = this.validateContent(newState.dialogState);
      if (newMap !== undefined) {
        newState = {...newState, disabledActions: newMap}
      }

      this.setState(newState);

      const window = remote.getCurrentWindow();
      if (window.isMinimized()) {
        window.restore();
      }
      window.setAlwaysOnTop(true);
      window.show();
      window.setAlwaysOnTop(false);
    }
  }

  public componentWillMount() {
    if (this.props.dialogs.length > 0) {
      this.setState(update(this.state, {
        currentDialogId: { $set: this.props.dialogs[0].id },
        dialogState: { $set: this.props.dialogs[0].content },
      }));
    }
  }

  public render(): JSX.Element {
    const { t, dialogs } = this.props;
    const { dialogState } = this.state;

    const dialog = dialogs.length > 0 ? dialogs[0] : undefined;

    if ((dialog === undefined) || (dialogState === undefined)) {
      return null;
    }

    const type = (dialog.content.htmlFile !== undefined) || (dialog.content.htmlText !== undefined)
      ? 'wide'
      : 'regular';
    return dialog !== undefined ? (
      <Modal className={`common-dialog-${type}`} show={dialog !== undefined} onHide={nop}>
        <Modal.Header>
          <Modal.Title>{this.iconForType(dialog.type)}{' '}{t(dialog.title)}</Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {this.renderContent(dialogState)}
        </Modal.Body>
        <Modal.Footer>
          {
            dialog.actions.map((action) =>
              this.renderAction(action, action === dialog.defaultAction))
          }
        </Modal.Footer>
      </Modal>
    ) : null;
  }

  private translateParts(message: string, t: I18next.TranslationFunction, parameters?: any) {
    // split by linebreak, then by tab, apply translation function, then join
    // again (replacing tabs with spaces)
    return message
      .split('\n')
      .map((line: string) => line
        .split('\t')
        .map((block: string) => t(block, { replace: parameters }))
        .join(' '))
      .join('\n');
  }

  private renderContent(content: IDialogContent): JSX.Element {
    let { t } = this.props;
    if (content.options && content.options.translated) {
      t = (input: any) => input;
    }

    const controls: JSX.Element[] = [];

    if (content.text) {
      controls.push((
        <div key='dialog-content-text' className='dialog-content-text'>
          {t(content.text, { replace: content.parameters })}
        </div>
      ));
    }

    if (content.message !== undefined) {
      const wrap = ((content.options !== undefined) && (content.options.wrap === true)) ? 'on' : 'off';
      const ctrl = (
        <textarea
          key='dialog-content-message'
          wrap={wrap}
          defaultValue={this.translateParts(content.message, t, content.parameters)}
          readOnly={true}
        />
      );
      if ((content.options !== undefined) && (content.options.hideMessage === true)) {
        controls.push((
          <Collapse key='dialog-content-message-wrapper' showText={t('Show Details')} hideText={t('Hide Details')}>
            {ctrl}
          </Collapse>));
      } else {
        controls.push(ctrl);
      }
    }

    if (content.bbcode !== undefined) {
      controls.push((
        <div key='dialog-content-bbcode' className='dialog-content-bbcode'>
          {bbcode(content.bbcode)}
        </div>
      ));
    }

    if (content.htmlFile !== undefined) {
      controls.push((
        <div key='dialog-content-html'>
          <Webview src={`file://${content.htmlFile}`} />
        </div>
      ));
    } else if (content.htmlText !== undefined) {
      controls.push((
        <div
          key='dialog-content-html'
          className='dialog-content-html'
          dangerouslySetInnerHTML={{ __html: content.htmlText }}
        />
      ));
    } else if (content.checkboxes !== undefined) {
      controls.push((
        <div key='dialog-content-choices' className='dialog-content-choices'>
          <div>
            {content.checkboxes.map(this.renderCheckbox)}
          </div>
        </div>
      ));
    } else if (content.choices !== undefined) {
      controls.push((
        <div key='dialog-content-choices' className='dialog-content-choices'>
          {content.choices.map(this.renderRadiobutton)}
        </div>
      ));
    } else if (content.input !== undefined) {
      controls.push((
      <div key='dialog-form-content'>
        {content.input.map(this.renderInput)}
      </div>
      ));
    } else if (content.links !== undefined) {
      controls.push((
        <div key='dialog-form-links'>
          {content.links.map(this.renderLink)}
        </div>
      ));
    }

    return <div className='dialog-container'>{controls}</div>;
  }

  private validateContent(dialogState: IDialogContent): DisabledActions {
    const { disabledActions } = this.state;
    if ((disabledActions === undefined) || (dialogState.condition === undefined)) {
      return undefined;
    }

    let newMap: DisabledActions = [];
    const res: DisabledActions = dialogState.condition(dialogState);
    res.length > 0
      ? newMap = res
      : newMap = [];

    return newMap;
  }

  private hasValidationError(input: IInput): boolean {
    const { disabledActions } = this.state;
    return disabledActions.find(res => res.id === input.id) !== undefined;
  }

  private renderInput = (input: IInput, idx: number) => {
    const { t } = this.props;
    const { dialogState } = this.state;
    let hasValidationError = undefined;
    if (dialogState.condition !== undefined) {
      hasValidationError = this.hasValidationError(input);
    }

    const getValidationStatus = () => {
      return hasValidationError !== undefined 
        ? hasValidationError ? 'error' : 'success'
        : null;
    }
    
    return (
      <FormGroup key={input.id} validationState={getValidationStatus()}>
      { input.label ? (
        <ControlLabel>{t(input.label)}</ControlLabel>
      ) : null }
      <FormControl
        id={`dialoginput-${input.id}`}
        type={input.type || 'text'}
        value={input.value || ''}
        label={input.label}
        placeholder={input.placeholder}
        onChange={this.changeInput}
        ref={idx === 0 ? this.focusMe : undefined}
      />
      {hasValidationError ? <label className='control-label'>{this.getErrorText(input)}</label> : null}
      </FormGroup>
    );
  }

  private renderLink = (link: ILink, idx: number) => {
    return (
      <a key={idx} onClick={this.triggerLink} data-linkidx={idx}>{link.label}</a>
    );
  }

  private triggerLink = (evt: React.MouseEvent<any>) => {
    evt.preventDefault();
    triggerDialogLink(this.props.dialogs[0].id, evt.currentTarget.getAttribute('data-linkidx'));
  }

  private renderCheckbox = (checkbox: ICheckbox) => {
    const { t } = this.props;
    return (
      <Checkbox
        id={checkbox.id}
        key={checkbox.id}
        checked={checkbox.value}
        onChange={this.toggleCheckbox}
      >
        {t(checkbox.text)}
      </Checkbox>
    );
  }

  private renderRadiobutton = (checkbox: ICheckbox) => {
    const { t } = this.props;
    return (
      <Radio
        id={checkbox.id}
        key={checkbox.id}
        name='dialog-radio'
        checked={checkbox.value}
        onChange={this.toggleRadio}
      >
        {t(checkbox.text)}
      </Radio>
    );
  }

  private focusMe = (ref: React.ReactInstance) => {
    if (ref !== null) {
      const ele = ReactDOM.findDOMNode(ref) as HTMLElement;
      setTimeout(() => ele.focus(), 100);
    }
  }

  private changeInput = evt => {
    const { dialogState } = this.state;

    const id = evt.currentTarget.id.split('-').slice(1).join('-');

    const idx = dialogState.input.findIndex(
      form => form.id === id);

    const newInput = { ...dialogState.input[idx] };
    newInput.value = evt.currentTarget.value;

    let newState = update(this.state, {
      dialogState: {
        input: { $splice: [[idx, 1, newInput]] },
      },
    });

    const newMap = this.validateContent(newState.dialogState);
    if (newMap !== undefined) {
      newState = {...newState, disabledActions: newMap}
    }

    this.setState(newState);
  }

  private toggleCheckbox = (evt: React.MouseEvent<any>) => {
    const { dialogState } = this.state;
    const idx = dialogState.checkboxes.findIndex((box: ICheckbox) => {
      return box.id === evt.currentTarget.id;
    });

    const newCheckboxes = JSON.parse(JSON.stringify(dialogState.checkboxes.slice(0)));
    newCheckboxes[idx].value = !newCheckboxes[idx].value;

    let newState = update(this.state, {
      dialogState: {
        checkboxes: { $set: newCheckboxes },
      },
    });

    const newMap = this.validateContent(newState.dialogState);
    if (newMap !== undefined) {
      newState = {...newState, disabledActions: newMap}
    }

    this.setState(newState);
  }

  private toggleRadio = (evt: React.MouseEvent<any>) => {
    const { dialogState } = this.state;
    const idx = dialogState.choices.findIndex((box: ICheckbox) => {
      return box.id === evt.currentTarget.id;
    });

    const newChoices = dialogState.choices.map((choice: ICheckbox) =>
      ({ id: choice.id, text: choice.text, value: false }));
    newChoices[idx].value = true;

    let newState = update(this.state, {
      dialogState: {
        choices: { $set: newChoices },
      },
    });

    const newMap = this.validateContent(newState.dialogState);
    if (newMap !== undefined) {
      newState = {...newState, disabledActions: newMap}
    }

    this.setState(newState);
  }

  private getErrorText(input: IInput): string {
    const { disabledActions } = this.state;

    let errorString = '';
    const errors = disabledActions.filter(res => res.id === input.id);
    if (errors.length === 0) {
      return undefined;
    }

    errors.forEach(error => {
      errorString = errorString !== '' 
        ? error.errorText + '\n' 
        : error.errorText;
    })

    return errorString;
  }

  private renderAction = (action: string, isDefault: boolean): JSX.Element => {
    const { disabledActions } = this.state;
    const { t } = this.props;
    const isDisabled = disabledActions.find(res => res.actions.find(act => act === action) !== undefined) !== undefined;
    return (
      <Action t={t} key={action} action={action} isDefault={isDefault} onDismiss={this.dismiss} isDisabled={isDisabled} />
    );
  }

  private iconForType(type: DialogType) {
    switch (type) {
      case 'info': return (
        <Icon name='dialog-info' className='icon-info'/>
      );
      case 'error': return (
        <Icon name='dialog-error' className='icon-error'/>
      );
      case 'question': return (
        <Icon name='dialog-question' className='icon-question'/>
      );
      default: return null;
    }
  }

  private dismiss = (action: string) => {
    const { dialogs, onDismiss } = this.props;
    const { dialogState } = this.state;

    const data = {};
    if (dialogState.checkboxes !== undefined) {
      dialogState.checkboxes.forEach((box: ICheckbox) => {
        data[box.id] = box.value;
      });
    }

    if (dialogState.choices !== undefined) {
      dialogState.choices.forEach((box: ICheckbox) => {
        data[box.id] = box.value;
      });
    }

    if (dialogState.input !== undefined) {
      dialogState.input.forEach(input => {
        data[input.id] = input.value;
      });
    }

    onDismiss(dialogs[0].id, action, data);
  }
}

function mapStateToProps(state: IState): IDialogConnectedProps {
  return {
    dialogs: state.session.notifications.dialogs,
  };
}

function mapDispatchToProps<S>(dispatch: ThunkDispatch<S, null, Redux.Action>): IDialogActionProps {
  return {
    onDismiss: (id: string, action: string, input: any) =>
      dispatch(closeDialog(id, action, input)),
  };
}

export default translate(['common'], { wait: false })(
  connect(mapStateToProps, mapDispatchToProps)(
    Dialog)) as React.ComponentClass<{}>;
