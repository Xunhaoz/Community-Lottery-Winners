import os
import json
import time
import requests
import random
import gradio as gr
import pandas as pd
import logging

from gradio.components.number import Number
from markdown_it.cli.parse import interactive


class LotteryWinner:
    IG_COMMENT_URL = "https://www.instagram.com/graphql/query/"
    COMMENTS_NUM_PER_REQUEST = 50
    COMMENT_DF_HEADER = ['編號', '留言帳號', '留言內容', '留言時間', '得獎資訊']

    mock_counter = 0

    def __init__(self):
        self.logger = logging.getLogger(self.__class__.__name__)

        with (gr.Blocks() as self.main):
            gr.Markdown('# Community Lottery Winners')
            with gr.Row(variant='panel', equal_height=True):
                with gr.Column(scale=4):
                    self.upload_json_title = gr.Markdown('## Upload Json Files from IG')
                    self.upload_json_btn = gr.UploadButton(label='Upload', file_types=['.json'])

                    gr.Markdown('## Scrap Comments from IG Post')
                    self.scrap_comments_btn = gr.Button(value='Scrap', interactive=False)

                    self.required_text = gr.Text(label='需要包含的文字')
                    self.required_account_num = gr.Slider(label='需要 Tag 多少帳號', minimum=0, maximum=5, step=0)
                    self.deadline = gr.DateTime(label='留言截止時間')

                    self.rewards = gr.DataFrame(
                        headers=['獎項名稱', '獎項數量'],
                        row_count=5,
                        interactive=True

                    )

                    with gr.Row():
                        self.can_multi_comment = gr.Checkbox(label='是否可以重複留言')
                        self.can_multi_reward = gr.Checkbox(label='是否可以重複得獎')

                    gr.Markdown('## Select Winners')
                    self.select_btn = gr.Button(value='Select', interactive=False)

                with gr.Column(scale=8):
                    self.comment_df = gr.Dataframe(
                        headers=self.COMMENT_DF_HEADER,
                        interactive=True,
                        show_search='search',
                        max_height=700,
                        buttons=['fullscreen', 'copy'],
                        column_widths=['5%', '15%', '40%', '20%', '20%']
                    )

                    self.download_csv_button = gr.Button(value='Download CSV', interactive=False)
                    self.download_btn_hidden = gr.DownloadButton(visible='hidden', elem_id="download_btn_hidden")

            self.ig_post_info = gr.State(dict())

            self.upload_json_btn.upload(
                self.get_ig_post_info_from_user,
                [self.upload_json_btn],
                [self.upload_json_title, self.ig_post_info, self.scrap_comments_btn],
                show_progress_on=[self.upload_json_btn, self.upload_json_title]
            )

            self.scrap_comments_btn.click(
                self.scrap_comments,
                [self.ig_post_info],
                [self.comment_df, self.select_btn, self.download_csv_button],
                show_progress_on=[self.scrap_comments_btn, self.comment_df]
            )

            self.select_btn.click(
                self.select_winners,
                [
                    self.required_text,
                    self.required_account_num,
                    self.deadline,
                    self.can_multi_comment,
                    self.can_multi_reward,
                    self.comment_df,
                    self.rewards
                ],
                [self.comment_df]
            )

            self.download_csv_button.click(
                self.download_csv,
                [self.comment_df, self.ig_post_info],
                [self.download_btn_hidden],
                show_progress_on=[self.comment_df]
            ).then(
                fn=None,
                inputs=None,
                outputs=None,
                js="() => document.querySelector('#download_btn_hidden').click()")




    def get_ig_post_info_from_user(self, file_path):
        request_headers_store = None
        shortcode = None

        with open(file_path) as f:
            file = json.load(f)
            request_headers_store = file['request_headers_store']
            shortcode = file['shortcode']

        headers = {
            'Accept': request_headers_store['Accept'],
            'Accept-Language': request_headers_store['Accept-Language'],
            'Cookie': request_headers_store['Cookie'],
            'Sec-Fetch-Dest': request_headers_store['Sec-Fetch-Dest'],
            'Sec-Fetch-Mode': request_headers_store['Sec-Fetch-Mode'],
            'Sec-Fetch-Site': request_headers_store['Sec-Fetch-Site'],
            'User-Agent': request_headers_store['User-Agent'],
            'X-CSRFToken': request_headers_store['X-CSRFToken'],
            'sec-ch-ua': request_headers_store['sec-ch-ua'],
            'sec-ch-ua-mobile': request_headers_store['sec-ch-ua-mobile'],
            'sec-ch-ua-platform': request_headers_store['sec-ch-ua-platform']
        }

        data = self._get_comment_from_ig(shortcode, headers)

        if not isinstance(data, dict):
            return {
                "## Upload Json Files from IG - failed",
                dict(),
                gr.Button(interactive=False)
            }
        else:
            ig_post_info = {'shortcode': shortcode, 'headers': headers}
            count = data['data']['shortcode_media']['edge_media_to_comment']['count']
            return (
                f"## Upload Json Files from IG - {count} comments funded",
                ig_post_info,
                gr.Button(interactive=True)
            )

    def scrap_comments(self, ig_post_info, progress=gr.Progress()):
        progress(0, desc="準備開始發送請求...")

        node_list = []
        data = self._get_comment_from_ig(ig_post_info['shortcode'], ig_post_info['headers'])
        edge_media_to_comment = data['data']['shortcode_media']['edge_media_to_comment']
        total_count = edge_media_to_comment['count']
        after = edge_media_to_comment['page_info']['end_cursor']
        has_next_page = edge_media_to_comment['page_info']['has_next_page']
        node_list.extend(edge_media_to_comment['edges'])
        curr_count = min(total_count, self.COMMENTS_NUM_PER_REQUEST)
        progress(curr_count / total_count, desc=f"正在處理第 {curr_count}/{total_count} 筆資料")

        while True:
            if not has_next_page:
                break

            data = self._get_comment_from_ig(ig_post_info['shortcode'], ig_post_info['headers'], after)
            edge_media_to_comment = data['data']['shortcode_media']['edge_media_to_comment']
            after = edge_media_to_comment['page_info']['end_cursor']
            has_next_page = edge_media_to_comment['page_info']['has_next_page']
            node_list.extend(edge_media_to_comment['edges'])
            curr_count = min(curr_count + self.COMMENTS_NUM_PER_REQUEST, total_count)
            progress(curr_count / total_count, desc=f"正在處理第 {curr_count}/{total_count} 筆資料")

        comment_df = pd.json_normalize(node_list)[['node.owner.username', 'node.text', 'node.created_at']]
        comment_df['node.created_at'] = pd.to_datetime(comment_df['node.created_at'], unit='s', utc=True).dt.tz_convert(
            'Asia/Taipei')
        comment_df['得獎資訊'] = ''
        comment_df = comment_df.reset_index()
        comment_df.columns = self.COMMENT_DF_HEADER
        comment_df['編號'] = comment_df['編號'] + 1
        return comment_df, gr.Button(interactive=True), gr.Button(interactive=True)

    def select_winners(
            self,
            required_text,
            required_account_num,
            deadline,
            can_multi_comment,
            can_multi_reward,
            comment_df,
            rewards,
            progress=gr.Progress()
    ):
        if required_text is not None and required_text != '':
            comment_df = comment_df[comment_df['留言內容'].str.contains(required_text)]

        pattern = r'(?:^|\s)@([\w\.]+)(?=\s|$)'
        comment_df = comment_df[comment_df['留言內容'].str.count(pattern) >= required_account_num]

        if deadline is not None:
            deadline = pd.Timestamp(int(deadline), tz='UTC', unit='s').tz_convert('Asia/Taipei')
            comment_df = comment_df[pd.to_datetime(comment_df['留言時間']) <= deadline]

        if not can_multi_comment:
            comment_df = comment_df.drop_duplicates(subset=['留言帳號'], keep='first')

        try:
            rewards['獎項數量'] = pd.to_numeric(rewards['獎項數量'])
        except Exception as e:
            self.logger.error(f"Convert reward count to numeric failed: {e}")
            raise gr.Error("獎項數量欄位必須為數字")

        if (rewards['獎項數量'] <= 0).any():
            self.logger.error(f"Reward count must be greater than 0")
            raise gr.Error("獎項數量欄位必須大於 0")

        if can_multi_reward:
            comment_df = comment_df.sample(n=rewards['獎項數量'].sum(), random_state=42)
        else:
            winner = comment_df.groupby('留言帳號')[['留言帳號']].count().sample(n=rewards['獎項數量'].sum(),
                                                                                 weights='留言帳號')
            candidate = comment_df.drop_duplicates(subset=['留言帳號'], keep='first')
            comment_df = candidate[candidate['留言帳號'].isin(winner.index)]

        rewards_list = []
        for idx, row in rewards.iterrows():
            reward_name = row['獎項名稱']
            reward_count = row['獎項數量']
            rewards_list.extend([reward_name] * reward_count)

        comment_df.loc[:, '得獎資訊'] = rewards_list
        comment_df.loc[:, '編號'] = range(1, comment_df.shape[0] + 1)

        for _ in range(rewards['獎項數量'].sum()):
            progress(_ / rewards['獎項數量'].sum(), desc=f"正在抽出第 {_:02d} / {rewards['獎項數量'].sum()} 中獎者")
            time.sleep(0.1)

        return comment_df

    def download_csv(self, comment_df, ig_post_info):
        csv_filename = f"{os.environ['GRADIO_TEMP_DIR']}/instagram_{ig_post_info['shortcode']}_{time.strftime('%Y%m%d')}.csv"
        comment_df.to_csv(csv_filename, index=False, encoding='utf-8-sig')
        logging.info(f" Prepare CSV file at {csv_filename}.")
        return csv_filename

    def _get_comment_from_ig(self, shortcode, headers, after=''):
        variables = {
            "shortcode": shortcode,
            "after": after,
            "first": self.COMMENTS_NUM_PER_REQUEST
        }

        params = {
            "query_hash": "33ba35852cb50da46f5b5e889df7d159",
            "variables": json.dumps(variables)
        }

        try:
            response = requests.get(self.IG_COMMENT_URL, headers=headers, params=params)
            time.sleep(random.random() * 2)
            self.logger.info(f" Get {shortcode} comments after: {after}.")
            if response.status_code == 200:
                data = response.json()
                return data
        except Exception as e:
            self.logger.error(f"{e}")

        return None

    def _get_comment_from_ig_mock_0(self, shortcode, headers, after=''):
        with open(f'mock_response_0.json', 'r') as f:
            data = json.load(f)
            self.logger.info(f" Mock Get {shortcode} comments after: {after}.")
            return data

    def _get_comment_from_ig_mock(self, shortcode, headers, after=''):
        with open(f'mock_response_{self.mock_counter}.json', 'r') as f:
            data = json.load(f)
            self.mock_counter = (self.mock_counter + 1) % 7
            self.logger.info(f" Mock Get {shortcode} comments after: {after}.")
            return data


if __name__ == '__main__':
    os.environ["GRADIO_TEMP_DIR"] = r"./temp"
    logging.basicConfig(level=logging.INFO)

    lottery_winner = LotteryWinner()
    lottery_winner.main.launch()
