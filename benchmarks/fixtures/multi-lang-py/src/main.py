# fixture：当输入字典缺少 'count' 键时，此处会抛 KeyError
def summarize(input_data):
    count = input_data['count']
    return f"共 {count} 项"


if __name__ == "__main__":
    print(summarize({}))
